/**
 * prompt_extra_rules.js — Extra rules for large payloads.
 * Loaded AFTER prompt_builder.js and wraps WMB.buildSystemPrompt
 * to append chunking and anti-duplicate rules without touching the original file.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  if (!WMB || WMB.extraRulesInstalled) return;
  WMB.extraRulesInstalled = true;

  WMB.EXTRA_RULES = [
    '',
    '## Rules for large payloads (code files)',
    '6. NEVER embed the full content of a file with more than 150 lines inside mcp_call: the JSON gets truncated by the token limit and the call fails with status="format_error".',
    '7. For large files, split the content into chunks of <= 150 lines and call create_or_update_file once per chunk (same branch, same path), in order, waiting for the result of each call before sending the next one.',
    '8. For chunks 2 and beyond, re-read the file with get_file_contents to obtain the updated sha before each create_or_update_file.',
    '9. If a staging tool (stage_file / flush_staged_file) is available, use it instead of embedding large content in a single JSON.',
    '10. Do not repeat an identical call that already returned status="ok": use the previous result. If you must re-run it, change the arguments or explain why.',
  ];

  const orig = WMB.buildSystemPrompt;
  if (typeof orig !== 'function') return;
  WMB.buildSystemPrompt = (tools) => {
    const base = orig(tools);
    const marker = '\n## Tools';
    const i = base.indexOf(marker);
    if (i === -1) return base + '\n' + WMB.EXTRA_RULES.join('\n');
    return base.slice(0, i) + '\n' + WMB.EXTRA_RULES.join('\n') + base.slice(i);
  };
})();
