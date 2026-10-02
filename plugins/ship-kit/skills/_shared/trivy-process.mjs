#!/usr/bin/env node
// Trivy scan post-processor for the daily security-scan workflow.
//
// Subcommands:
//   digest    — parse Trivy JSON, subtract suppressions + in-flight, append
//               new findings to SECURITY-BRIEF.md, update in-flight.json
//   list      — print in-flight fingerprints as a JSON array (for the skill)
//   resolve   — mark an in-flight finding resolved (status: fixed | suppressed
//               | accepted | false-positive) — used by the security-brief skill
//   summary   — emit a one-line counts summary from in-flight.json
//
// State model (see docs/security-scanning.md):
//   security/suppressed.json         (on develop) — permanent suppressions
//   security/accepted-risks.json     (on develop) — time-boxed accepted risks
//   security/in-flight.json          (on security/alerts) — currently open
//   security/SECURITY-BRIEF.md       (on security/alerts) — reviewer checklist
//   .trivyignore                     (on develop) — native Trivy ignore file
//
// Severity threshold defaults to HIGH (HIGH + CRITICAL surface). Adjust with
// --min-severity. UNKNOWN is always treated as below MEDIUM.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SEVERITY_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

const DEFAULTS = {
  suppressed: 'security/suppressed.json',
  accepted: 'security/accepted-risks.json',
  inFlight: 'security/in-flight.json',
  brief: 'security/SECURITY-BRIEF.md',
  minSeverity: 'HIGH',
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[k] = v;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${err.message}`);
  }
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function loadIgnoreFile(path) {
  // .trivyignore — one vuln/misconfig ID per line, `#` comments. We use this
  // as a secondary suppression source so Trivy and our brief agree.
  if (!existsSync(path)) return new Set();
  const ids = readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
  return new Set(ids);
}

function fingerprintVuln(target, v) {
  return `vuln|${target}|${v.VulnerabilityID}|${v.PkgName}|${v.InstalledVersion}`;
}
function fingerprintMisconfig(target, m) {
  const line = m.CauseMetadata?.StartLine ?? m.CauseMetadata?.Resource ?? '0';
  return `misconfig|${target}|${m.ID || m.AVDID}|${line}`;
}
function fingerprintSecret(target, s) {
  return `secret|${target}|${s.RuleID}|${s.StartLine ?? 0}`;
}

function severityAtLeast(sev, threshold) {
  return (SEVERITY_RANK[sev] ?? 0) >= (SEVERITY_RANK[threshold] ?? 3);
}

function collectFindings(scan, minSeverity) {
  const findings = [];
  for (const r of scan.Results ?? []) {
    const target = r.Target;
    for (const v of r.Vulnerabilities ?? []) {
      if (!severityAtLeast(v.Severity, minSeverity)) continue;
      findings.push({
        fingerprint: fingerprintVuln(target, v),
        category: 'vuln',
        severity: v.Severity,
        target,
        id: v.VulnerabilityID,
        pkg: v.PkgName,
        installedVersion: v.InstalledVersion,
        fixedVersion: v.FixedVersion || null,
        title: v.Title || v.VulnerabilityID,
        description: v.Description || '',
        primaryURL: v.PrimaryURL || '',
        references: v.References || [],
      });
    }
    for (const m of r.Misconfigurations ?? []) {
      if (!severityAtLeast(m.Severity, minSeverity)) continue;
      findings.push({
        fingerprint: fingerprintMisconfig(target, m),
        category: 'misconfig',
        severity: m.Severity,
        target,
        id: m.ID || m.AVDID,
        title: m.Title || m.ID,
        description: m.Description || '',
        resolution: m.Resolution || '',
        startLine: m.CauseMetadata?.StartLine ?? null,
        primaryURL: m.PrimaryURL || '',
        references: m.References || [],
      });
    }
    for (const s of r.Secrets ?? []) {
      if (!severityAtLeast(s.Severity, minSeverity)) continue;
      findings.push({
        fingerprint: fingerprintSecret(target, s),
        category: 'secret',
        severity: s.Severity,
        target,
        id: s.RuleID,
        title: s.Title || s.RuleID,
        description: `${s.Category || ''} ${s.Match || ''}`.trim(),
        startLine: s.StartLine ?? null,
      });
    }
  }
  return findings;
}

function loadKnownFingerprints({ suppressed, accepted, inFlight, ignoreFile }) {
  const known = new Set();
  for (const fp of Object.keys(suppressed.entries ?? {})) known.add(fp);
  for (const fp of Object.keys(accepted.entries ?? {})) known.add(fp);
  for (const fp of Object.keys(inFlight.entries ?? {})) known.add(fp);
  // .trivyignore stores IDs, not fingerprints — we match by ID substring.
  return { known, ignoredIds: ignoreFile };
}

function isIgnoredById(finding, ignoredIds) {
  if (ignoredIds.has(finding.id)) return true;
  return false;
}

function renderFindingMarkdown(f, scanDate) {
  const lines = [];
  const sev = (f.severity || 'UNKNOWN').toUpperCase();
  const header =
    f.category === 'vuln'
      ? `## [${sev}] ${f.id} — ${f.pkg} ${f.installedVersion}${f.fixedVersion ? ` → ${f.fixedVersion}` : ''}`
      : f.category === 'misconfig'
        ? `## [${sev}] ${f.id} — ${f.target}${f.startLine ? `:${f.startLine}` : ''}`
        : `## [${sev}] ${f.id} — secret in ${f.target}${f.startLine ? `:${f.startLine}` : ''}`;
  lines.push(header);
  lines.push(`<!-- fingerprint: ${f.fingerprint} -->`);
  lines.push(`<!-- category: ${f.category} -->`);
  lines.push(`- **First seen:** ${scanDate}`);
  lines.push(`- **Where:** ${f.target}${f.startLine ? `:${f.startLine}` : ''}`);
  if (f.category === 'vuln') {
    lines.push(`- **Package:** \`${f.pkg}\` @ ${f.installedVersion}`);
    if (f.fixedVersion) lines.push(`- **Fixed in:** ${f.fixedVersion}`);
  }
  lines.push(`- **Title:** ${f.title}`);
  if (f.description) {
    const desc = f.description.replace(/\s+/g, ' ').slice(0, 400);
    lines.push(`- **Description:** ${desc}${f.description.length > 400 ? '…' : ''}`);
  }
  if (f.resolution) {
    lines.push(`- **Trivy resolution hint:** ${f.resolution.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  if (f.primaryURL) lines.push(`- **Primary ref:** ${f.primaryURL}`);
  lines.push('- **Status:** `[ ] fix`  `[ ] suppress`  `[ ] accept-risk`  `[ ] false-positive`');
  lines.push('- **Resolution notes:** _(reviewer fills in)_');
  lines.push('');
  return lines.join('\n');
}

function ensureBriefHeader(brief, scanDate) {
  if (brief.includes('# Security brief')) return brief;
  const header = [
    '# Security brief',
    '',
    'Daily Trivy scan findings awaiting reviewer action. See',
    '[`docs/security-scanning.md`](../docs/security-scanning.md) for the model and the',
    'reviewer runbook. Process this brief with the `security-brief` skill —',
    '`/security-brief` in Claude Code.',
    '',
    `_Brief opened: ${scanDate}. Newer scan runs append findings; resolved findings move to the "Resolved" section._`,
    '',
    '---',
    '',
    '## Open findings',
    '',
  ];
  return `${header.join('\n')}${brief}`;
}

function appendToBrief(briefPath, newFindings, scanDate) {
  const existing = existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : '';
  const withHeader = ensureBriefHeader(existing, scanDate);
  const banner = `\n<!-- scan-batch: ${scanDate} +${newFindings.length} -->\n`;
  const sections = newFindings.map((f) => renderFindingMarkdown(f, scanDate)).join('\n');
  const next = `${withHeader}${banner}${sections}`;
  mkdirSync(dirname(briefPath), { recursive: true });
  writeFileSync(briefPath, next);
}

function summarize(findings) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  const byCategory = { vuln: 0, misconfig: 0, secret: 0 };
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  }
  return { counts, byCategory };
}

function cmdDigest(args) {
  const scanPath = args.scan;
  if (!scanPath) {
    console.error(
      'usage: digest --scan <trivy.json> [--min-severity HIGH] [--scan-date YYYY-MM-DD]',
    );
    process.exit(2);
  }
  const minSeverity = (args['min-severity'] || DEFAULTS.minSeverity).toUpperCase();
  const scanDate = args['scan-date'] || new Date().toISOString().slice(0, 10);
  const suppressedPath = resolve(args.suppressed || DEFAULTS.suppressed);
  const acceptedPath = resolve(args.accepted || DEFAULTS.accepted);
  const inFlightPath = resolve(args['in-flight'] || DEFAULTS.inFlight);
  const briefPath = resolve(args.brief || DEFAULTS.brief);
  const ignorePath = resolve(args.ignore || '.trivyignore');

  const scan = readJson(resolve(scanPath));
  const suppressed = readJson(suppressedPath, { version: 1, entries: {} });
  const accepted = readJson(acceptedPath, { version: 1, entries: {} });
  const inFlight = readJson(inFlightPath, { version: 1, scanDate, entries: {} });
  const ignoreFile = loadIgnoreFile(ignorePath);

  const all = collectFindings(scan, minSeverity);
  const { known, ignoredIds } = loadKnownFingerprints({
    suppressed,
    accepted,
    inFlight,
    ignoreFile,
  });

  const newFindings = all.filter((f) => !known.has(f.fingerprint) && !isIgnoredById(f, ignoredIds));

  const summary = summarize(newFindings);
  const totalSummary = summarize(all);

  if (newFindings.length === 0) {
    // Emit zero so the workflow can decide to skip. Also useful for cron logs.
    console.log(
      `NEW_FINDINGS=0 TOTAL_FINDINGS=${all.length} ` +
        `KNOWN=${known.size} IGNORED=${ignoredIds.size} ` +
        `THRESHOLD=${minSeverity} SCAN_DATE=${scanDate}`,
    );
    process.exit(0);
  }

  // Persist new findings into in-flight state and append to brief.
  for (const f of newFindings) {
    inFlight.entries[f.fingerprint] = {
      firstSeen: scanDate,
      severity: f.severity,
      category: f.category,
      target: f.target,
      id: f.id,
      title: f.title,
      status: 'open',
    };
  }
  inFlight.scanDate = scanDate;
  writeJson(inFlightPath, inFlight);
  appendToBrief(briefPath, newFindings, scanDate);

  console.log(
    `NEW_FINDINGS=${newFindings.length} TOTAL_FINDINGS=${all.length} ` +
      `KNOWN=${known.size} IGNORED=${ignoredIds.size} ` +
      `THRESHOLD=${minSeverity} SCAN_DATE=${scanDate}`,
  );
  console.log(
    `NEW_BY_SEVERITY crit=${summary.counts.CRITICAL} high=${summary.counts.HIGH} ` +
      `med=${summary.counts.MEDIUM} low=${summary.counts.LOW}`,
  );
  console.log(
    `TOTAL_BY_SEVERITY crit=${totalSummary.counts.CRITICAL} high=${totalSummary.counts.HIGH} ` +
      `med=${totalSummary.counts.MEDIUM} low=${totalSummary.counts.LOW}`,
  );

  // GH Actions output
  if (process.env.GITHUB_OUTPUT) {
    const ghOutput = [
      `new_findings=${newFindings.length}`,
      `critical=${summary.counts.CRITICAL}`,
      `high=${summary.counts.HIGH}`,
      `medium=${summary.counts.MEDIUM}`,
      `scan_date=${scanDate}`,
    ].join('\n');
    writeFileSync(process.env.GITHUB_OUTPUT, `${ghOutput}\n`, { flag: 'a' });
  }
}

function cmdList(args) {
  const inFlightPath = resolve(args['in-flight'] || DEFAULTS.inFlight);
  const inFlight = readJson(inFlightPath, { version: 1, entries: {} });
  const onlyOpen = args.open !== 'false';
  const entries = Object.entries(inFlight.entries ?? {})
    .filter(([, e]) => (onlyOpen ? e.status === 'open' : true))
    .map(([fingerprint, e]) => ({ fingerprint, ...e }));
  console.log(JSON.stringify(entries, null, 2));
}

function cmdResolve(args) {
  const fp = args.fingerprint;
  const status = args.status;
  if (!fp || !status) {
    console.error(
      'usage: resolve --fingerprint <fp> --status <fixed|suppressed|accepted|false-positive> [--rationale <text>] [--reviewed-by <id>]',
    );
    process.exit(2);
  }
  const allowed = new Set(['fixed', 'suppressed', 'accepted', 'false-positive']);
  if (!allowed.has(status)) {
    console.error(`status must be one of: ${[...allowed].join(', ')}`);
    process.exit(2);
  }
  const inFlightPath = resolve(args['in-flight'] || DEFAULTS.inFlight);
  const inFlight = readJson(inFlightPath, { version: 1, entries: {} });
  if (!inFlight.entries[fp]) {
    console.error(`fingerprint not in in-flight state: ${fp}`);
    process.exit(1);
  }
  inFlight.entries[fp].status = status;
  inFlight.entries[fp].resolvedAt = new Date().toISOString().slice(0, 10);
  if (args.rationale) inFlight.entries[fp].rationale = args.rationale;
  if (args['reviewed-by']) inFlight.entries[fp].reviewedBy = args['reviewed-by'];
  writeJson(inFlightPath, inFlight);
  console.log(`resolved ${fp} → ${status}`);

  // For suppressed / accepted / false-positive, append to the appropriate
  // persistent store so the next scan after merge still treats them as known.
  // 'fixed' findings drop off naturally — once the fix lands, the next scan
  // won't re-detect them.
  if (status === 'suppressed' || status === 'false-positive') {
    const suppressedPath = resolve(args.suppressed || DEFAULTS.suppressed);
    const suppressed = readJson(suppressedPath, { version: 1, entries: {} });
    suppressed.entries[fp] = {
      rationale: args.rationale || `Marked ${status}`,
      reviewedBy: args['reviewed-by'] || 'unknown',
      reviewedAt: new Date().toISOString().slice(0, 10),
      kind: status,
    };
    writeJson(suppressedPath, suppressed);
    console.log(`  → added to ${suppressedPath}`);
  } else if (status === 'accepted') {
    const acceptedPath = resolve(args.accepted || DEFAULTS.accepted);
    const accepted = readJson(acceptedPath, { version: 1, entries: {} });
    const reEvalDays = Number(args['re-evaluate-days'] || 90);
    const reEvalAt = new Date(Date.now() + reEvalDays * 86_400_000).toISOString().slice(0, 10);
    accepted.entries[fp] = {
      rationale: args.rationale || 'Risk accepted',
      reviewedBy: args['reviewed-by'] || 'unknown',
      reviewedAt: new Date().toISOString().slice(0, 10),
      reEvaluateAt: reEvalAt,
    };
    writeJson(acceptedPath, accepted);
    console.log(`  → added to ${acceptedPath} (re-evaluate by ${reEvalAt})`);
  }
}

function cmdSummary(args) {
  const inFlightPath = resolve(args['in-flight'] || DEFAULTS.inFlight);
  const inFlight = readJson(inFlightPath, { version: 1, entries: {} });
  const open = Object.values(inFlight.entries ?? {}).filter((e) => e.status === 'open');
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  for (const e of open) counts[e.severity] = (counts[e.severity] ?? 0) + 1;
  console.log(
    `open=${open.length} critical=${counts.CRITICAL} high=${counts.HIGH} ` +
      `medium=${counts.MEDIUM} low=${counts.LOW}`,
  );
}

const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);

switch (cmd) {
  case 'digest':
    cmdDigest(args);
    break;
  case 'list':
    cmdList(args);
    break;
  case 'resolve':
    cmdResolve(args);
    break;
  case 'summary':
    cmdSummary(args);
    break;
  default:
    console.error('usage: trivy-process {digest|list|resolve|summary} [args]');
    process.exit(2);
}
