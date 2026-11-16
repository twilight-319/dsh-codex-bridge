/**
 * Client half of the Codex bridge: one global panel (sidebar icon + `main` page).
 *
 * Loaded by the Harness Web module table as a self-registering script. The page
 * reads `GET /api/dsh-codex-bridge.page` and posts page consults / resets to the
 * same path; both routes are registered by the Host half through
 * `ctx.connection.fetch` (browser-authenticated), so no bearer token is exposed
 * to this code.
 *
 * Colours come only from the host theme tokens (`--dsw-alias-*`) so light/dark
 * switching and future token renames stay safe.
 *
 * @module @local/dsh-codex-bridge/client
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-codex-bridge',
  factory(require) {
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    var PAGE_ID = 'dsh-codex-bridge'
    var API = '/api/dsh-codex-bridge.v2.page'
    var CHEVRON =
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888e96' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")"

    var CSS = `
.cb-page {
  box-sizing: border-box; height: 100%; overflow-y: auto; overflow-x: hidden;
  padding: 26px 34px 56px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}
.cb-page ::selection { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); }
.cb-inner { width: 100%; max-width: 1160px; margin: 0 auto; min-width: 0; display: flex; flex-direction: column; gap: 20px; }
.cb-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.cb-head-main { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
.cb-mark {
  width: 34px; height: 34px; flex: 0 0 auto; border-radius: 10px; box-sizing: border-box;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, var(--dsw-alias-bg-layer-1));
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent);
  color: var(--dsw-alias-brand-primary);
}
.cb-title-row { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; }
.cb-title { margin: 0; font-size: 21px; font-weight: 650; letter-spacing: .2px; line-height: 1.25; }
.cb-version { font-size: 11px; line-height: 1; padding: 3px 7px; border-radius: 999px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); font-variant-numeric: tabular-nums; }
.cb-sub { margin: 5px 0 0; font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary); max-width: 640px; }
.cb-head-side { display: flex; align-items: center; gap: 12px; flex: 0 0 auto; padding-top: 4px; }
.cb-head-meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cb-btn {
  appearance: none; font: inherit; cursor: pointer; box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  height: 32px; padding: 0 14px; border-radius: 8px; font-size: 12.5px; line-height: 1;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); flex: 0 0 auto; transition: background .12s ease, border-color .12s ease, opacity .12s ease;
}
.cb-btn:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.cb-btn:disabled { opacity: .5; cursor: default; }
.cb-btn-primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; font-weight: 600; }
.cb-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); filter: brightness(1.08); border-color: transparent; }
.cb-btn-ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); padding: 0 10px; }
.cb-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-color: transparent; }

.cb-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(304px, 1fr)); gap: 14px; align-items: stretch; }
.cb-card {
  box-sizing: border-box; min-width: 0; display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px; padding: 15px 17px 13px;
}
.cb-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 11px; }
.cb-card-title { font-size: 13px; font-weight: 650; letter-spacing: .1px; }
.cb-chip {
  display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto;
  font-size: 11px; line-height: 1; padding: 4px 8px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); white-space: nowrap;
}
.cb-chip-ok { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 26%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 13%, transparent); }
.cb-chip-warn { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 26%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 13%, transparent); }
.cb-chip-err { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 13%, transparent); }
.cb-chip-brand { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }

.cb-rows { display: flex; flex-direction: column; gap: 0; }
.cb-row { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 12px; align-items: start; padding: 6px 0; font-size: 12.5px; line-height: 1.5; }
.cb-row + .cb-row { border-top: 1px dashed var(--dsw-alias-border-l1); }
.cb-label { color: var(--dsw-alias-label-secondary); white-space: nowrap; font-size: 12px; }
.cb-value { min-width: 0; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary); }
.cb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; letter-spacing: -.1px; }
.cb-muted { color: var(--dsw-alias-label-secondary); }
.cb-codes { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.cb-code {
  display: block; box-sizing: border-box; max-width: 100%;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5;
  padding: 3px 7px; border-radius: 6px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
  overflow-wrap: anywhere;
}
.cb-card-note { margin-top: 10px; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }

.cb-section { display: flex; flex-direction: column; gap: 9px; }
.cb-section-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.cb-section-title { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: .1px; }
.cb-section-count { font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.cb-section-hint { margin-left: auto; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }

.cb-table { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; overflow: hidden; }
.cb-thead, .cb-run {
  display: grid; grid-template-columns: 108px 104px 128px minmax(0, 1fr);
  gap: 12px; align-items: center; padding: 9px 17px;
}
.cb-thead { font-size: 11px; color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l1); letter-spacing: .2px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent); }
.cb-thead > span:last-child { text-align: right; }
.cb-run { border-top: 1px solid var(--dsw-alias-border-l1); cursor: pointer; user-select: none; min-height: 40px; }
.cb-thead + .cb-run { border-top: none; }
.cb-run:hover { background: var(--dsw-alias-bg-layer-2); }
.cb-run:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.cb-run-time { font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cb-run-kind { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 600; }
.cb-dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-state-idle-primary); }
.cb-dot-decide { background: var(--dsw-alias-brand-primary); }
.cb-dot-plan { background: var(--dsw-alias-state-success-primary); }
.cb-dot-review { background: var(--dsw-alias-state-warn-primary); }
.cb-dot-ask { background: var(--dsw-alias-state-idle-primary); }
.cb-run-mode { display: flex; }
.cb-mode { display: inline-flex; align-items: center; font-size: 11px; line-height: 1; padding: 4px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.cb-mode-appserver { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 26%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.cb-mode-fallback { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 26%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 13%, transparent); }
.cb-run-meta { text-align: right; font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cb-run-meta b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.cb-detail { padding: 12px 17px 16px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 70%, transparent); border-top: 1px solid var(--dsw-alias-border-l1); display: flex; flex-direction: column; gap: 4px; }
.cb-kv { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 12px; font-size: 12px; line-height: 1.55; }
.cb-kv-label { color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.cb-kv-value { min-width: 0; overflow-wrap: anywhere; }
.cb-pre {
  margin: 8px 0 0; box-sizing: border-box; padding: 10px 12px; border-radius: 9px;
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.65;
  white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto;
  color: var(--dsw-alias-label-primary);
}
.cb-empty { padding: 26px 18px; display: flex; flex-direction: column; gap: 4px; align-items: center; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
.cb-empty b { color: var(--dsw-alias-label-primary); font-weight: 600; font-size: 13px; }

.cb-form-card { box-sizing: border-box; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; padding: 16px 18px 15px; display: flex; flex-direction: column; gap: 11px; }
.cb-form-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cb-form-note { font-size: 11.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary); max-width: 720px; }
.cb-form-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cb-form-grow { flex: 1 1 auto; min-width: 0; }
.cb-select {
  appearance: none; -webkit-appearance: none; box-sizing: border-box;
  height: 32px; padding: 0 30px 0 11px; border-radius: 8px; font: inherit; font-size: 12.5px;
  color: var(--dsw-alias-label-primary); background-color: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); background-image: ${CHEVRON};
  background-repeat: no-repeat; background-position: right 10px center; cursor: pointer;
}
.cb-select:hover { border-color: var(--dsw-alias-border-l2); }
.cb-select:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.cb-textarea {
  box-sizing: border-box; width: 100%; min-height: 88px; resize: vertical;
  border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12.5px; line-height: 1.65; padding: 11px 13px;
}
.cb-textarea::placeholder { color: var(--dsw-alias-label-secondary); }
.cb-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); }
.cb-count { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.cb-kbd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; padding: 2px 5px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.cb-error { box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 11%, transparent); color: var(--dsw-alias-state-error-primary); border-radius: 10px; padding: 10px 13px; font-size: 12.5px; line-height: 1.6; }
.cb-result { box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 14px 16px 13px; background: var(--dsw-alias-bg-base); display: flex; flex-direction: column; gap: 9px; }
.cb-result-head { display: flex; align-items: center; gap: 8px; }
.cb-result-title { font-size: 12px; font-weight: 650; color: var(--dsw-alias-label-secondary); letter-spacing: .2px; }
.cb-result-meta { margin-left: auto; font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.cb-decision { font-size: 15px; font-weight: 650; line-height: 1.5; overflow-wrap: anywhere; }
.cb-steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
.cb-step { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; font-size: 12.5px; line-height: 1.6; }
.cb-step-id { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.cb-step-files { color: var(--dsw-alias-label-secondary); font-size: 11.5px; overflow-wrap: anywhere; }
.cb-foot { font-size: 11px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.cb-spin { display: inline-block; width: 11px; height: 11px; border: 1.6px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: cb-spin .8s linear infinite; }
@keyframes cb-spin { to { transform: rotate(360deg); } }
.cb-skel { border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
.cb-skel-line { height: 12px; animation: cb-pulse 1.4s ease-in-out infinite; }
.cb-skel-line + .cb-skel-line { margin-top: 9px; }
.cb-skel-line.w70 { width: 70%; }
.cb-skel-line.w45 { width: 45%; }
@keyframes cb-pulse { 0%, 100% { opacity: .45; } 50% { opacity: .9; } }
@media (prefers-reduced-motion: reduce) { .cb-spin, .cb-skel-line { animation: none; } }
@media (max-width: 720px) {
  .cb-page { padding: 18px 16px 40px; }
  .cb-head { flex-direction: column; }
  .cb-thead, .cb-run { grid-template-columns: 84px 88px minmax(0, 1fr); }
  .cb-thead > span:nth-child(3), .cb-run-mode { display: none; }
}

.cbv-page { box-sizing: border-box; height: 100%; overflow-y: auto; padding: 20px 28px 40px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; }
.cbv-inner { max-width: 920px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.cbv-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.cbv-title { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: .1px; }
.cbv-sub { margin: 5px 0 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); max-width: 600px; }
.cbv-head-side { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; padding-top: 3px; }
.cbv-count { font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.cbv-project { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; overflow: hidden; }
.cbv-project-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 45%, transparent); }
.cbv-project-name { font-size: 12.5px; font-weight: 650; }
.cbv-project-cwd { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.cbv-project-count { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.cbv-list { display: flex; flex-direction: column; }
.cbv-session { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; cursor: pointer; border-top: 1px solid var(--dsw-alias-border-l1); }
.cbv-session:first-child { border-top: none; }
.cbv-session:hover { background: var(--dsw-alias-bg-layer-2); }
.cbv-session:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.cbv-dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; flex: 0 0 auto; background: var(--dsw-alias-state-idle-primary); }
.cbv-dot-running { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent); animation: cbv-pulse 1.6s ease-in-out infinite; }
.cbv-dot-done { background: var(--dsw-alias-state-success-primary); }
.cbv-dot-failed { background: var(--dsw-alias-state-error-primary); }
.cbv-dot-interrupted { background: var(--dsw-alias-state-warn-primary); }
.cbv-session-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.cbv-task { font-size: 12.5px; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.cbv-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.cbv-sid { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.cbv-chevron { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-secondary); padding-top: 2px; }
.cbv-detail { padding: 6px 14px 14px 31px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 60%, transparent); border-top: 1px solid var(--dsw-alias-border-l1); display: flex; flex-direction: column; gap: 7px; }
.cbv-kv { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 10px; font-size: 12px; line-height: 1.55; }
.cbv-kv-label { color: var(--dsw-alias-label-secondary); }
.cbv-pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; max-height: 210px; overflow: auto; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; }
.cbv-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; overflow-wrap: anywhere; }
.cbv-empty { padding: 30px 16px; display: flex; flex-direction: column; align-items: center; gap: 5px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
.cbv-empty b { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; }
@keyframes cbv-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .cbv-dot-running { animation: none; } }

.cx-page { box-sizing: border-box; height: 100%; display: flex; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; overflow: hidden; }
.cx-side { box-sizing: border-box; flex: 0 0 300px; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.cx-side-head { padding: 12px 12px 8px; display: flex; align-items: center; gap: 8px; }
.cx-side-title { font-size: 13px; font-weight: 650; }
.cx-side-count { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.cx-search { margin: 0 12px 8px; }
.cx-search input { box-sizing: border-box; width: 100%; height: 30px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 0 10px; }
.cx-search input::placeholder { color: var(--dsw-alias-label-secondary); }
.cx-search input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.cx-tree { flex: 1 1 auto; overflow-y: auto; padding: 2px 6px 14px; }
.cx-project { margin-top: 6px; }
.cx-project-head { display: flex; align-items: baseline; gap: 6px; padding: 5px 7px; border-radius: 6px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.cx-project-name { font-weight: 650; color: var(--dsw-alias-label-primary); font-size: 12px; }
.cx-project-count { margin-left: auto; font-variant-numeric: tabular-nums; }
.cx-thread { display: flex; flex-direction: column; gap: 2px; padding: 6px 9px; border-radius: 7px; cursor: pointer; margin: 1px 0; }
.cx-thread:hover { background: var(--dsw-alias-bg-layer-2); }
.cx-thread-active { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.cx-thread-name { font-size: 12px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cx-thread-meta { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.cx-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.cx-main-head { padding: 12px 20px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); display: flex; flex-direction: column; gap: 4px; }
.cx-main-title { font-size: 14px; font-weight: 650; }
.cx-main-sub { display: flex; gap: 8px; align-items: center; font-size: 11px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.cx-badge { font-size: 10.5px; padding: 3px 7px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); color: var(--dsw-alias-brand-primary); white-space: nowrap; }
.cx-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 18px 22px 12px; display: flex; flex-direction: column; gap: 12px; }
.cx-msg { display: flex; flex-direction: column; gap: 4px; max-width: 82%; }
.cx-msg-user { align-self: flex-end; align-items: flex-end; }
.cx-msg-role { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.cx-bubble { padding: 9px 12px; border-radius: 12px; font-size: 12.5px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.cx-msg-user .cx-bubble { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary); border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); }
.cx-msg-assistant .cx-bubble { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.cx-composer { border-top: 1px solid var(--dsw-alias-border-l1); padding: 10px 20px 12px; display: flex; flex-direction: column; gap: 8px; }
.cx-composer textarea { box-sizing: border-box; width: 100%; min-height: 64px; max-height: 180px; resize: vertical; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; line-height: 1.65; padding: 9px 12px; }
.cx-composer textarea::placeholder { color: var(--dsw-alias-label-secondary); }
.cx-composer textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); }
.cx-composer-row { display: flex; align-items: center; gap: 10px; }
.cx-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.cx-hint b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.cx-empty { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; text-align: center; padding: 30px; }
.cx-empty b { color: var(--dsw-alias-label-primary); font-size: 13.5px; }
.cx-error { margin: 12px 20px 0; }
.cbn-workbench{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.cbn-tabs{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;flex-shrink:0;flex-wrap:wrap}.cbn-tabs strong{margin-right:16px}.cbn-tabs button{font:inherit;color:var(--dsw-alias-label-secondary);border:1px solid transparent;background:transparent;border-radius:7px;padding:7px 12px;cursor:pointer}.cbn-tabs button.active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.cbn-executions{flex:1;min-height:0;overflow:auto;padding:24px;}.cbn-heading{display:flex;align-items:center;gap:20px;justify-content:space-between}.cbn-heading h2{margin:0;font-size:18px;font-weight:600}.cbn-heading p{font-size:12px;color:var(--dsw-alias-label-secondary);margin:8px 0 18px}.cbn-notice{padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);margin-bottom:16px}.cbn-search{box-sizing:border-box;width:100%;max-width:560px;padding:9px 12px;font:inherit;font-size:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);margin-bottom:24px}.cbn-project{margin-bottom:24px}.cbn-project-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding-bottom:10px;font-size:13px}.cbn-project-head code{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.cbn-record{display:flex;gap:20px;align-items:center;padding:15px 0;border-top:1px solid var(--dsw-alias-border-l1)}.cbn-record-body{flex:1;min-width:0}.cbn-record-body strong{display:block;font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;font-weight:500}.cbn-record code{font-size:10px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}.cbn-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:10px;color:var(--dsw-alias-label-secondary);margin:6px 0}.cbn-split{flex:1;min-height:0;display:flex}.cbn-index{width:290px;flex:0 0 290px;min-height:0;background:var(--dsw-alias-bg-layer-1);border-right:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column}.cbn-index-head{display:flex;align-items:center;gap:8px;padding:18px 14px 12px;font-size:12px}.cbn-index-head>span{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-secondary)}.cbn-index .cbn-search{width:calc(100% - 28px);margin:0 14px 14px;max-width:none}.cbn-index-list{flex:1;overflow:auto;padding:0 8px 16px}.cbn-project-label{display:flex;justify-content:space-between;font-size:12px;font-weight:600;padding:10px 9px}.cbn-project-label small{color:var(--dsw-alias-label-secondary)}.cbn-session-choice{border:1px solid transparent;display:flex;flex-direction:column;gap:6px;background:transparent;width:100%;padding:12px;text-align:left;color:var(--dsw-alias-label-primary);border-radius:7px;cursor:pointer;font:inherit;font-size:12px}.cbn-session-choice>span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.cbn-session-choice small{font-size:10px;color:var(--dsw-alias-label-secondary)}.cbn-session-choice:hover{background:var(--dsw-alias-bg-layer-2)}.cbn-session-choice.selected{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}.cbn-index-foot{margin:0;padding:14px;font-size:10px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1)}.cbn-detail{flex:1;min-width:0;overflow:auto}.cbn-detail-head{padding:28px 30px 22px;border-bottom:1px solid var(--dsw-alias-border-l1)}.cbn-eyebrow{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:12px}.cbn-detail-head h2{font-size:19px;font-weight:600;margin:0 0 10px;overflow-wrap:anywhere}.cbn-detail-head code{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.cbn-detail-content{max-width:940px;margin:auto;padding:28px 30px}.cbn-native-callout{padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.cbn-native-callout h3,.cbn-result-preview h3{margin:0 0 10px;font-size:13px;font-weight:600}.cbn-native-callout p{font-size:12px;line-height:1.8;color:var(--dsw-alias-label-secondary);margin:0 0 17px}.cbn-workbench .cbn-open-native{background:#365fd1!important;border-color:#365fd1!important;color:#ffffff!important;font-weight:600;min-height:36px}.cbn-workbench .cbn-open-native:hover{background:#294db3!important}.cbn-facts{display:grid;grid-template-columns:90px minmax(0,1fr);gap:15px 14px;padding:24px 0;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}.cbn-facts dt{color:var(--dsw-alias-label-secondary)}.cbn-facts dd{margin:0;overflow-wrap:anywhere}.cbn-result-preview{padding:15px 0}.cbn-result-preview p{white-space:pre-wrap;font-size:13px;line-height:1.85;overflow-wrap:anywhere}.cbn-bottom-note{font-size:11px;line-height:1.8;color:var(--dsw-alias-label-secondary);margin-top:26px}@media(max-width:900px){.cbn-index{width:230px;flex-basis:230px}.cbn-detail-head,.cbn-detail-content{padding:20px}}@media(max-width:600px){.cbn-split{flex-direction:column;overflow:auto}.cbn-index{width:100%;flex:0 0 auto;max-height:240px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.cbn-detail{overflow:visible}.cbn-index-foot{display:none}}
.cbn-workbench>.cx-page{flex:1;height:auto;min-height:0}.cbn-workbench .cx-side{width:280px;flex-basis:280px}.cx-thread{width:100%;border:0;background:transparent;color:inherit;text-align:left;font:inherit}
@media(max-width:700px){.cbn-executions{padding:16px}.cbn-record{align-items:flex-start;flex-direction:column;gap:10px}.cbn-heading{align-items:flex-start}.cbn-workbench .cx-side{width:220px;flex-basis:220px}}
`

    var KIND_META = {
      decide: { label: '裁决', dot: 'cb-dot-decide' },
      plan: { label: '计划', dot: 'cb-dot-plan' },
      review: { label: '审查', dot: 'cb-dot-review' },
      ask: { label: '问答', dot: 'cb-dot-ask' },
    }
    var MODE_META = {
      'app-server': { label: 'app-server', cls: 'cb-mode-appserver' },
      exec: { label: 'exec', cls: '' },
      'exec-fallback': { label: 'exec 回退', cls: 'cb-mode-fallback' },
    }

    function asJson(res) {
      if (res.ok) return res.json()
      return res.json().then(
        function (body) {
          throw new Error((body && body.error) || 'HTTP ' + res.status)
        },
        function () {
          throw new Error('HTTP ' + res.status)
        },
      )
    }
    function jget() {
      return fetch(API, { credentials: 'same-origin', cache: 'no-store' }).then(asJson)
    }
    function jpost(body) {
      return fetch(API, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(asJson)
    }

    function fmtTokens(value) {
      var n = Number(value) || 0
      return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n)
    }
    function fmtDuration(value) {
      var ms = Number(value) || 0
      if (ms === 0) return '—'
      return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's'
    }
    function fmtWhen(value) {
      var ts = Number(value) || 0
      var delta = Date.now() - ts
      if (delta < 45_000) return '刚刚'
      if (delta < 3_600_000) return Math.round(delta / 60_000) + ' 分钟前'
      if (delta < 86_400_000) return Math.round(delta / 3_600_000) + ' 小时前'
      return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
    function absTime(value) {
      var ts = Number(value) || 0
      return ts ? new Date(ts).toLocaleString('zh-CN') : ''
    }
    function basename(path) {
      var parts = String(path || '').split(/[\\/]/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : String(path || '')
    }

    function Chip(props) {
      return h('span', { className: 'cb-chip ' + (props.cls || '') }, props.children || props.text)
    }
    function Row(props) {
      return h(
        'div',
        { className: 'cb-row' },
        h('span', { className: 'cb-label' }, props.label),
        h('div', { className: 'cb-value' + (props.mono ? ' cb-mono' : '') }, props.children),
      )
    }
    function CodeLines(props) {
      return h(
        'div',
        { className: 'cb-codes' },
        (props.items || []).map(function (item) {
          return h('code', { className: 'cb-code', key: item }, item)
        }),
      )
    }
    function StatusCard(props) {
      return h(
        'section',
        { className: 'cb-card' },
        h('div', { className: 'cb-card-head' }, h('span', { className: 'cb-card-title' }, props.title), props.chip ? h(Chip, { cls: props.chipCls || '' }, props.chip) : null),
        props.loading
          ? h(
              'div',
              null,
              h('div', { className: 'cb-skel cb-skel-line w70' }),
              h('div', { className: 'cb-skel cb-skel-line w45' }),
              h('div', { className: 'cb-skel cb-skel-line w70' }),
            )
          : props.children,
      )
    }
    function Mark(props) {
      var size = props.size || 20
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', { d: 'M4.6 9.3a3.1 3.1 0 1 1 4.4 2.8', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M16.9 15.1a3.1 3.1 0 1 0 2.6-4.8', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M8.7 9.7c2.1 1.1 4.5 2.9 6.5 5.1', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('circle', { cx: 12.4, cy: 12, r: 1.5, fill: 'currentColor' }),
      )
    }

    function ConsultResult(props) {
      var kind = props.kind
      var value = props.value || {}
      var meta = props.meta || {}
      var mode = MODE_META[meta.mode] || { label: meta.mode || 'exec', cls: '' }
      var km = KIND_META[kind] || KIND_META.ask
      var body
      if (kind === 'decide') {
        body = [
          h('div', { className: 'cb-decision', key: 'd' }, value.decision || '—'),
          h(Kv, { label: '理由', key: 'r' }, value.rationale || '—'),
          h(Kv, { label: '置信度', key: 'c' }, fmtConfidence(value.confidence)),
          h(Kv, { label: '下一步', key: 'n' }, value.nextAction || '—'),
          value.alternatives && value.alternatives.length
            ? h(Kv, { label: '被否方案', key: 'a' }, value.alternatives.map(function (item) { return '· ' + (item.option || '') + ' — ' + (item.whyNot || '') }).join('\n'))
            : null,
        ]
      } else if (kind === 'plan') {
        body = [
          h('div', { className: 'cb-decision', key: 't' }, value.task || '—'),
          h(
            'ol',
            { className: 'cb-steps', key: 's' },
            (value.steps || []).map(function (step, index) {
              return h(
                'li',
                { className: 'cb-step', key: index },
                h('span', { className: 'cb-step-id' }, String(step.id || index + 1) + '.'),
                h(
                  'span',
                  null,
                  step.action || '',
                  step.files && step.files.length ? h('div', { className: 'cb-step-files' }, step.files.join(' · ')) : null,
                  h('div', { className: 'cb-step-files' }, 'risk ' + (step.risk || '—') + (step.why ? ' · ' + step.why : '')),
                ),
              )
            }),
          ),
          value.acceptance && value.acceptance.length ? h(Kv, { label: '验收', key: 'ac' }, value.acceptance.join('；')) : null,
        ]
      } else {
        body = [
          h('div', { className: 'cb-decision', key: 'a' }, value.answer || '—'),
          value.keyPoints && value.keyPoints.length ? h(Kv, { label: '要点', key: 'k' }, value.keyPoints.join('\n')) : null,
          h(Kv, { label: '下一步', key: 'n' }, value.nextAction || '—'),
        ]
      }
      return h(
        'div',
        { className: 'cb-result' },
        h(
          'div',
          { className: 'cb-result-head' },
          h('span', { className: 'cb-result-title' }, 'Codex 回话'),
          h(Chip, { cls: 'cb-chip-brand' }, km.label),
          h('span', { className: 'cb-result-meta' }, (meta.model || 'native') + ' · ' + mode.label + ' · ' + fmtDuration(meta.elapsedMs) + ' · ' + fmtTokens(meta.inputTokens) + ' in / ' + fmtTokens(meta.outputTokens) + ' out'),
        ),
        body,
      )
    }

    function fmtConfidence(value) {
      var n = Number(value)
      if (!Number.isFinite(n)) return '—'
      return (Math.round(n * 100) / 100).toFixed(2)
    }
    function Kv(props) {
      return h('div', { className: 'cb-kv' }, h('span', { className: 'cb-kv-label' }, props.label), h('span', { className: 'cb-kv-value' }, props.children))
    }


    var CODEX_API = '/api/dsh-codex-bridge.v2.codex'

    var CODEX_STATUS = { running: '进行中', done: '完成', failed: '失败', interrupted: '中断' }

    function StatusDot(props) {
      return h('span', { className: 'cbv-dot cbv-dot-' + props.status, title: props.status })
    }

    function CodexSessionRow(props) {
      var session = props.session
      var open = props.open
      var onCopy = function (event) {
        event.stopPropagation()
        try {
          navigator.clipboard.writeText(session.sessionId)
        } catch (error) {
          /* clipboard is optional */
        }
      }
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'cbv-session', role: 'button', tabIndex: 0, 'aria-expanded': open, onClick: props.onToggle },
          h(StatusDot, { status: session.status }),
          h(
            'div',
            { className: 'cbv-session-main' },
            h('div', { className: 'cbv-task' }, session.task || '（空任务）'),
            h(
              'div',
              { className: 'cbv-meta' },
              h('span', null, fmtWhen(session.startedAt)),
              h('span', null, '·'),
              h('span', null, (CODEX_STATUS[session.status] || session.status) + (session.status === 'running' ? '' : ' · ' + fmtDuration(session.elapsedMs))),
              h('span', { className: 'cbv-sid' }, String(session.sessionId).slice(0, 16) + '…'),
            ),
          ),
          h('span', { className: 'cbv-chevron' }, open ? '收起' : '详情'),
        ),
        open
          ? h(
              'div',
              { className: 'cbv-detail' },
              h('div', { className: 'cbv-kv' }, h('span', { className: 'cbv-kv-label' }, '任务'), h('div', { className: 'cbv-pre' }, session.task || '—')),
              h('div', { className: 'cbv-kv' }, h('span', { className: 'cbv-kv-label' }, '结果'), h('div', { className: 'cbv-pre' }, session.text || session.error || '（无文本结果）')),
              h('div', { className: 'cbv-kv' }, h('span', { className: 'cbv-kv-label' }, '状态'), h('div', null, session.status + (session.stopReason ? ' · ' + session.stopReason : '') + (session.error ? ' · ' + session.error : ''))),
              h('div', { className: 'cbv-kv' }, h('span', { className: 'cbv-kv-label' }, '工作目录'), h('div', { className: 'cbv-mono' }, session.cwd || '—')),
              h(
                'div',
                { className: 'cbv-kv' },
                h('span', { className: 'cbv-kv-label' }, 'session'),
                h('div', { className: 'cbv-mono' }, String(session.sessionId), ' ', h('button', { className: 'cb-btn cb-btn-ghost', type: 'button', onClick: onCopy }, '复制')),
              ),
            )
          : null,
      )
    }

    function CodexSessionsView() {
      var dataState = useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var loadingState = useState(true)
      var loading = loadingState[0]
      var setLoading = loadingState[1]
      var errorState = useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var expandedState = useState('')
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]

      var load = useCallback(function () {
        setLoading(true)
        fetch(CODEX_API, { credentials: 'same-origin', cache: 'no-store' })
          .then(asJson)
          .then(function (next) {
            setData(next)
            setError('')
          })
          .catch(function (cause) {
            setError(String((cause && cause.message) || cause))
          })
          .then(function () {
            setLoading(false)
          })
      }, [])

      useEffect(
        function () {
          load()
          var timer = setInterval(load, 5000)
          return function () {
            clearInterval(timer)
          }
        },
        [load],
      )

      var projects = ((data && data.projects) || [])
        .map(function (project) {
          return Object.assign({}, project, {
            visible: project.sessions.filter(function (session) { return String(session.sessionId).indexOf('probe-') !== 0 }),
          })
        })
        .filter(function (project) { return project.visible.length > 0 })
      var visibleCount = projects.reduce(function (total, project) { return total + project.visible.length }, 0)
      return h(
        'div',
        { className: 'cbv-page' },
        h(
          'div',
          { className: 'cbv-inner' },
          h(
            'header',
            { className: 'cbv-head' },
            h(
              'div',
              null,
              h('h1', { className: 'cbv-title' }, 'Codex 子会话'),
              h('p', { className: 'cbv-sub' }, 'Codex 通过 dsh_execute 在本机拉起的 DSH 会话，按工作目录分组。它们不挂在任何工作区，所以主界面侧栏看不到；这里是它们的记录。'),
            ),
            h(
              'div',
              { className: 'cbv-head-side' },
              data ? h('span', { className: 'cbv-count' }, visibleCount + ' 条' + (data.running ? ' · ' + data.running + ' 进行中' : '')) : null,
              h('button', { className: 'cb-btn', type: 'button', onClick: load, disabled: loading }, loading ? h('span', { className: 'cb-spin' }) : null, loading ? '刷新中' : '刷新'),
            ),
          ),
          error ? h('div', { className: 'cb-error' }, '读取 Codex 子会话失败：' + error) : null,
          data && projects.length === 0
            ? h('div', { className: 'cbv-empty' }, h('b', null, '还没有 Codex 拉起的会话'), h('span', null, '在 Codex App 里让它调用 mcp__dsh_bridge__dsh_execute，这里就会出现对应的 DSH 子会话。'))
            : null,
          projects.map(function (project) {
            return h(
              'section',
              { className: 'cbv-project', key: project.cwd || project.name },
              h(
                'div',
                { className: 'cbv-project-head' },
                h('span', { className: 'cbv-project-name' }, project.name),
                h('span', { className: 'cbv-project-cwd' }, project.cwd || ''),
                h('span', { className: 'cbv-project-count' }, project.visible.length + ' 条' + (project.running ? ' · ' + project.running + ' 运行中' : '')),
              ),
              h(
                'div',
                { className: 'cbv-list' },
                project.visible.map(function (session) {
                  return h(CodexSessionRow, {
                    key: session.sessionId,
                    session: session,
                    open: expanded === session.sessionId,
                    onToggle: function () {
                      setExpanded(expanded === session.sessionId ? '' : session.sessionId)
                    },
                  })
                }),
              ),
            )
          }),
          data ? h('div', { className: 'cb-foot' }, '数据来源 ~/.dsh/codex-bridge/codex-sessions.jsonl · 每 5 秒自动刷新 · ' + fmtWhen(data.generatedAt) + '更新') : null,
        ),
      )
    }


    var CX_PROJECTS = '/api/dsh-codex-bridge.v3.codex'
    var CX_THREAD = '/api/dsh-codex-bridge.v3.codex.thread'
    var CX_SEND = '/api/dsh-codex-bridge.v3.codex.send'

    function fmtClock(ts) {
      var value = Number(ts) || 0
      if (value === 0) return ''
      var date = new Date(value)
      var now = new Date()
      var sameDay = date.toDateString() === now.toDateString()
      return sameDay
        ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
        : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
    }

    function cxJson(res) {
      if (res.ok) return res.json()
      return res.json().then(function (body) {
        throw new Error((body && body.error) || 'HTTP ' + res.status)
      }, function () {
        throw new Error('HTTP ' + res.status)
      })
    }

    function CodexBubble(props) {
      return h(
        'div',
        { className: 'cx-msg cx-msg-' + props.role },
        h('span', { className: 'cx-msg-role' }, props.role === 'user' ? '你' : 'Codex'),
        h('div', { className: 'cx-bubble' }, props.text),
      )
    }

    // Retained across panel navigation; no messages are sent by these controls.
    var nativeWorkbench = { view: 'executions', query: '', threadId: '', executionId: '' }
    var nativeOpen = null

    function NativeExecutions() {
      var dataPair = useState(null), data = dataPair[0], setData = dataPair[1]
      var errorPair = useState(''), error = errorPair[0], setError = errorPair[1]
      var busyPair = useState(false), busy = busyPair[0], setBusy = busyPair[1]
      var queryPair = useState(nativeWorkbench.query), query = queryPair[0], setQuery = queryPair[1]
      var selectedPair = useState(nativeWorkbench.executionId), selectedId = selectedPair[0], setSelectedId = selectedPair[1]
      var navigationErrorPair = useState(''), navigationError = navigationErrorPair[0], setNavigationError = navigationErrorPair[1]
      var alive = React.useRef(true)
      var navigationRequest = React.useRef(0)
      var load = useCallback(function () {
        setBusy(true)
        return fetch('/api/dsh-codex-bridge.v2.codex', { credentials: 'same-origin', cache: 'no-store' })
          .then(cxJson).then(function (value) { if (alive.current) { setData(value); setError('') } })
          .catch(function (cause) { if (alive.current) setError(String(cause.message || cause)) })
          .finally(function () { if (alive.current) setBusy(false) })
      }, [])
      useEffect(function () {
        alive.current = true
        load()
        var timer = setInterval(load, 10000)
        return function () { alive.current = false; clearInterval(timer) }
      }, [load])
      var term = query.trim().toLowerCase()
      var groups = ((data && data.projects) || []).map(function (project) {
        return Object.assign({}, project, { visible: (project.sessions || []).filter(function (record) {
          return typeof record.sessionId === 'string' && record.sessionId.indexOf('session-') === 0 && [record.task, record.cwd, record.sessionId].join(' ').toLowerCase().indexOf(term) >= 0
        }) })
      }).filter(function (project) { return project.visible.length })
      function open(record) {
        nativeWorkbench.executionId = record.sessionId
        var request = ++navigationRequest.current
        function current() { return alive.current && navigationRequest.current === request }
        setNavigationError('')
        Promise.resolve().then(function () {
          if (!current()) return
          if (!nativeOpen) throw new Error('原生会话导航服务尚未就绪，请刷新窗口。')
          return nativeOpen(record.sessionId, current)
        }).catch(function (cause) { if (current()) setNavigationError('无法打开原生会话：' + String(cause.message || cause)) })
      }
      var records = groups.reduce(function (all, project) { return all.concat(project.visible) }, [])
      var selected = records.find(function (record) { return record.sessionId === selectedId }) || records[0]
      function status(record) {
        if (!record.endedAt) return '状态待确认'
        var reason = record.stopReason || ''
        return reason === 'completed' || reason === 'idle' ? '已结束' : reason === 'input-required' ? '当时等待输入' : reason === 'error' ? '执行出错' : '已中断 / ' + reason
      }
      return h('div', { className: 'cbn-split' },
        h('aside', { className: 'cbn-index', 'aria-label': '项目与执行会话' },
          h('div', { className: 'cbn-index-head' }, h('strong', null, '项目与执行'), h('span', null, records.length + ' 条'), h('button', { className: 'cb-btn', type: 'button', disabled: busy, onClick: load }, busy ? '…' : '刷新')),
          h('input', { className: 'cbn-search', 'aria-label': '搜索 DSH 执行记录', placeholder: '搜索任务、目录或会话', value: query, onChange: function (event) { navigationRequest.current++; nativeWorkbench.query = event.target.value; setQuery(event.target.value) } }),
          h('div', { className: 'cbn-index-list' }, groups.map(function (project) {
            return h('section', { key: project.cwd || project.name },
              h('div', { className: 'cbn-project-label', title: project.cwd }, project.name, h('small', null, project.visible.length)),
              project.visible.map(function (record) {
                return h('button', { type: 'button', className: 'cbn-session-choice' + (selected && selected.sessionId === record.sessionId ? ' selected' : ''), key: record.sessionId, 'aria-pressed': Boolean(selected && selected.sessionId === record.sessionId), onClick: function () { navigationRequest.current++; nativeWorkbench.executionId = record.sessionId; setSelectedId(record.sessionId) } },
                  h('span', null, record.task || '未记录任务'), h('small', null, 'DSH · ' + status(record) + ' · ' + fmtWhen(record.startedAt)))
              }))
          })),
          h('p', { className: 'cbn-index-foot' }, '真实台账 · 只按目录分组。旧记录缺少 Codex 父会话关联。')),
        h('section', { className: 'cbn-detail' },
          error ? h('div', { className: 'cb-error', role: 'alert' }, error) : null,
          navigationError ? h('div', { className: 'cb-error', role: 'alert' }, navigationError) : null,
          selected ? h(React.Fragment, null,
            h('header', { className: 'cbn-detail-head' }, h('div', { className: 'cbn-eyebrow' }, 'DSH 执行子会话 / ' + status(selected)), h('h2', null, selected.task || '执行会话'), h('code', null, selected.cwd || '未记录工作目录')),
            h('div', { className: 'cbn-detail-content' },
              h('div', { className: 'cbn-native-callout' }, h('h3', null, '完整过程，使用 DSH 原生会话'), h('p', null, '消息、工具参数与输出、轨迹和审批都在官方会话中查看。本工作台不复制或伪造执行记录。'), h('button', { type: 'button', className: 'cb-btn cbn-open-native', onClick: function () { open(selected) } }, '打开 DSH 原生会话')),
              h('dl', { className: 'cbn-facts' }, h('dt', null, '会话 ID'), h('dd', null, selected.sessionId), h('dt', null, '开始时间'), h('dd', null, absTime(selected.startedAt)), h('dt', null, '执行耗时'), h('dd', null, fmtDuration(selected.elapsedMs)), h('dt', null, 'Codex 关联'), h('dd', null, '未记录父会话 ID · 不自动猜配')),
              selected.execution ? h('section', { className: 'cbn-result-preview' },
                h('h3', null, '本次执行使用的模型'),
                h('p', null,
                  selected.execution.provider + '/' + selected.execution.model
                  + ' · 强度 ' + (selected.execution.reasoningEffort || '（模型默认）')
                  + ' · ' + ({ 'dsh-default': '跟随 DSH 默认', 'model-default': '模型默认档', 'adapter-default': '适配器默认', 'policy-fixed': '政策固定', 'policy-default': '政策默认档', caller: 'Codex 按政策选择' }[selected.execution.effortSource] || selected.execution.effortSource || '')
                  + (selected.execution.reason ? ' · 原因：' + selected.execution.reason : '')),
                h('small', { style: { opacity: 0.7 } }, '政策 revision ' + (selected.execution.policyRevision ?? 0) + ' · ' + (selected.execution.effortMode || ''))) : null,
              selected.text ? h('section', { className: 'cbn-result-preview' }, h('h3', null, '当时的结果摘要'), h('p', null, selected.text)) : null,
              h('div', { className: 'cbn-bottom-note' }, '打开后点击左侧 Codex 返回；保留当前选择。原生页面可输入、审批和停止，仍遵循 DSH 权限。台账最多200条、每目录60条，不代表完整历史。')))
            : h('div', { className: 'cx-empty' }, h('b', null, busy ? '正在读取执行会话…' : '没有匹配的执行记录'), h('span', null, term ? '请调整搜索条件。' : '连接修复后，Codex 发起的新执行会出现在这里。'))))
    }


    var POLICY_API = '/api/dsh-codex-bridge.execution-policy'
    var policyInputStyle = {
      background: 'var(--dsh-surface, #1b1d22)',
      color: 'var(--dsh-text, #e8eaf0)',
      border: '1px solid var(--dsh-border, #3a3f4b)',
      borderRadius: '8px',
      padding: '7px 9px',
      fontSize: '13px',
      minWidth: '180px',
    }

    function ModelPolicySettings() {
      var statePair = useState(null), state = statePair[0], setState = statePair[1]
      var draftPair = useState(null), draft = draftPair[0], setDraft = draftPair[1]
      var errorPair = useState(''), error = errorPair[0], setError = errorPair[1]
      var noticePair = useState(''), notice = noticePair[0], setNotice = noticePair[1]
      var busyPair = useState(false), busy = busyPair[0], setBusy = busyPair[1]
      var alive = React.useRef(true)
      function policyJson(res) {
        return res.json().then(function (body) {
          if (res.ok && body && body.ok !== false) return body
          throw new Error((body && (body.message || body.error)) || 'HTTP ' + res.status)
        }, function () { throw new Error('HTTP ' + res.status) })
      }
      function toDraft(policy) {
        return {
          modelMode: policy.modelMode || 'follow-default',
          provider: policy.provider || '',
          model: policy.model || '',
          effortMode: policy.effortMode || 'inherit',
          fixedEffort: policy.fixedEffort || '',
          allowedEfforts: Array.isArray(policy.allowedEfforts) ? policy.allowedEfforts.slice() : [],
          defaultEffort: policy.defaultEffort || '',
          permissionMode: policy.permissionMode || 'inherit',
          fullAccessAck: policy.permissionMode === 'full-access',
        }
      }
      var load = useCallback(function () {
        setBusy(true)
        return fetch(POLICY_API, { credentials: 'same-origin', cache: 'no-store' })
          .then(policyJson)
          .then(function (value) {
            if (!alive.current) return
            setState(value)
            setDraft(toDraft(value.policy))
            setError('')
          })
          .catch(function (cause) { if (alive.current) setError('读取执行模型设置失败：' + String(cause.message || cause)) })
          .finally(function () { if (alive.current) setBusy(false) })
      }, [])
      useEffect(function () {
        alive.current = true
        load()
        return function () { alive.current = false }
      }, [load])
      function update(patch) {
        setNotice('')
        setDraft(function (current) { return Object.assign({}, current, patch) })
      }
      function groupOf(provider) {
        return state && state.catalog.groups.filter(function (group) { return group.id === provider })[0]
      }
      function modelsOf(provider) {
        var group = groupOf(provider)
        return (group && group.models) || []
      }
      // The effective route must be resolved from the SAME source the executor
      // will use: follow-default reads the catalog default, not the empty draft.
      function routeOf(catalog, value) {
        if (!catalog) return { provider: '', model: '' }
        return value.modelMode === 'follow-default'
          ? catalog.default
          : { provider: value.provider, model: value.model }
      }
      function entryOf(catalog, value) {
        var route = routeOf(catalog, value)
        return modelsOf(route.provider).filter(function (model) { return model.id === route.model })[0]
      }
      function permissionOption(value, label, hint) {
        return h('label', { className: 'cbn-policy-option', style: { display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '6px 0' } },
          h('input', { type: 'radio', name: 'permissionMode', checked: draft.permissionMode === value, onChange: function () {
            update({ permissionMode: value, fullAccessAck: false })
          } }),
          h('span', null, h('strong', null, label), h('small', { style: { display: 'block', opacity: 0.72, marginTop: '2px' } }, hint)))
      }
      function save() {
        if (!state || !draft) return
        setBusy(true)
        setNotice('')
        var body = {
          expectedRevision: state.policy.revision,
          modelMode: draft.modelMode,
          effortMode: draft.effortMode,
          permissionMode: draft.permissionMode,
        }
        if (draft.permissionMode === 'full-access') {
          if (!draft.fullAccessAck) {
            setBusy(false)
            setError('完全权限需要勾选风险确认后才能保存。')
            return
          }
          body.ackFullAccess = true
        }
        if (draft.modelMode === 'pinned') { body.provider = draft.provider; body.model = draft.model }
        if (draft.effortMode === 'fixed') body.fixedEffort = draft.fixedEffort
        if (draft.effortMode === 'adaptive') {
          body.allowedEfforts = draft.allowedEfforts
          body.defaultEffort = draft.defaultEffort
        }
        fetch(POLICY_API, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(policyJson).then(function (value) {
          if (!alive.current) return
          setState({ ok: true, policy: value.policy, catalog: value.catalog })
          setDraft(toDraft(value.policy))
          setNotice('已保存。之后由 Codex 发起的新执行会使用这套设置；已在运行或已结束的会话不变。')
          setError('')
        }).catch(function (cause) {
          if (alive.current) setError('保存失败：' + String(cause.message || cause))
        }).finally(function () { if (alive.current) setBusy(false) })
      }
      function radio(name, value, label, hint, disabled) {
        return h('label', { className: 'cbn-policy-option', style: { display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '6px 0', opacity: disabled ? 0.5 : 1 } },
          h('input', { type: 'radio', name: name, checked: draft[name] === value, disabled: Boolean(disabled), onChange: function () {
            if (name === 'modelMode') {
              var patch = { modelMode: value }
              // Moving to a pinned route needs a concrete catalogue entry.
              if (value === 'pinned' && !draft.provider && state) {
                var firstGroup = state.catalog.groups[0]
                var firstModel = firstGroup && firstGroup.models[0]
                patch.provider = firstGroup ? firstGroup.id : ''
                patch.model = firstModel ? firstModel.id : ''
                patch.fixedEffort = ''
                patch.allowedEfforts = []
                patch.defaultEffort = ''
              }
              update(patch)
              return
            }
            update({ effortMode: value, fixedEffort: '', allowedEfforts: [], defaultEffort: '' })
          } }),
          h('span', null, h('strong', null, label), hint ? h('small', { style: { display: 'block', opacity: 0.72, marginTop: '2px' } }, hint) : null))
      }
      var view
      if (error && !state) {
        view = h('div', { className: 'cb-error', role: 'alert' }, error,
          h('button', { type: 'button', className: 'cb-btn', style: { marginLeft: '10px' }, onClick: load }, '重试'))
      } else if (!state || !draft) {
        view = h('div', { className: 'cx-empty' }, h('b', null, '正在读取 DSH 模型目录…'))
      } else {
        var catalog = state.catalog
        var currentRoute = routeOf(catalog, draft)
        var currentEntry = entryOf(catalog, draft)
        var efforts = (currentEntry && currentEntry.reasoning && currentEntry.reasoning.efforts) || []
        var supportsEffort = Boolean(currentEntry && currentEntry.reasoning)
        var pins = catalog.groups.map(function (group) {
          return h('option', { key: group.id, value: group.id }, group.name + ' (' + group.id + ')')
        })
        var models = modelsOf(draft.provider).map(function (model) {
          return h('option', { key: model.id, value: model.id }, model.name + ' · ' + model.id)
        })
        view = h('div', { className: 'cbn-policy' },
          h('header', { className: 'cbn-detail-head' },
            h('div', { className: 'cbn-eyebrow' }, '执行模型政策 · revision ' + state.policy.revision),
            h('h2', null, 'Codex 可以怎么使用 DSH 执行'),
            h('p', { style: { opacity: 0.78, margin: '6px 0 0' } }, '这里选择的模型来自 DSH 已配置的模型源，不是插件写死的。设置只影响之后新建的执行会话，不改 DSH 全局默认模型。')),
          error ? h('div', { className: 'cb-error', role: 'alert' }, error) : null,
          notice ? h('div', { className: 'cbn-policy-notice', role: 'status', style: { background: 'rgba(54,95,209,.14)', border: '1px solid rgba(54,95,209,.5)', borderRadius: '8px', padding: '8px 10px', margin: '10px 0' } }, notice) : null,
          h('section', { style: { marginTop: '18px' } },
            h('h3', null, '1. 执行模型'),
            radio('modelMode', 'follow-default', '跟随 DSH 默认模型', '每次新执行开始前读取当时的 DSH 默认：' + catalog.default.provider + '/' + catalog.default.model),
            radio('modelMode', 'pinned', '指定桥专用模型', '只用于 Codex 通过本桥发起的执行，不影响其他 DSH 会话'),
            draft.modelMode === 'pinned' ? h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', margin: '8px 0 0 26px' } },
              h('select', { style: policyInputStyle, 'aria-label': '模型源', value: draft.provider, onChange: function (event) {
                var provider = event.target.value
                var first = modelsOf(provider)[0]
                update({ provider: provider, model: first ? first.id : '', fixedEffort: '', allowedEfforts: [], defaultEffort: '' })
              } }, h('option', { value: '' }, '选择模型源'), pins),
              h('select', { style: policyInputStyle, 'aria-label': '执行模型', value: draft.model, onChange: function (event) {
                update({ model: event.target.value, fixedEffort: '', allowedEfforts: [], defaultEffort: '' })
              } }, h('option', { value: '' }, '选择模型'), models)) : null,
            catalog.failures.length ? h('p', { style: { opacity: 0.7, margin: '8px 0 0' } }, '部分模型源目录当前不可用：' + catalog.failures.map(function (item) { return item.name }).join('、')) : null),
          h('section', { style: { marginTop: '18px' } },
            h('h3', null, '2. 思考强度'),
            radio('effortMode', 'inherit', '继承（不额外指定）', '跟随该模型/DSH 默认的强度，不改写'),
            radio('effortMode', 'fixed', '固定一个档位', '每次执行都用同一个强度，Codex 不能改', !supportsEffort),
            radio('effortMode', 'adaptive', 'Codex 在你允许的范围内选择', '你勾选可选档位并指定默认档；Codex 可根据任务难度挑其中一个，超出范围会被桥接拒绝', !supportsEffort),
            !supportsEffort ? h('p', { style: { color: '#f0b45a', margin: '6px 0 0 26px' } }, '当前模型目录没有声明可调思考强度，只能使用「继承」。') : null,
            draft.effortMode === 'fixed' ? h('div', { style: { margin: '8px 0 0 26px' } },
              h('select', { style: policyInputStyle, 'aria-label': '固定思考强度', value: draft.fixedEffort, disabled: !supportsEffort, onChange: function (event) { update({ fixedEffort: event.target.value }) } },
                h('option', { value: '' }, '选择档位'), efforts.map(function (effort) { return h('option', { key: effort.id, value: effort.id }, effort.name + ' · ' + effort.id) }))) : null,
            draft.effortMode === 'adaptive' ? h('div', { style: { margin: '8px 0 0 26px' } },
              h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap' } }, efforts.map(function (effort) {
                var checked = draft.allowedEfforts.indexOf(effort.id) >= 0
                return h('label', { key: effort.id, style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                  h('input', { type: 'checkbox', 'aria-label': '允许强度 ' + effort.id, checked: checked, disabled: !supportsEffort, onChange: function () {
                    var next = checked ? draft.allowedEfforts.filter(function (id) { return id !== effort.id }) : draft.allowedEfforts.concat([effort.id])
                    update({ allowedEfforts: next, defaultEffort: next.indexOf(draft.defaultEffort) >= 0 ? draft.defaultEffort : (next[0] || '') })
                  } }),
                  effort.name + '（' + effort.id + '）')
              })),
              h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } }, 'Codex 未指定时使用',
                h('select', { style: policyInputStyle, value: draft.defaultEffort, disabled: !draft.allowedEfforts.length, onChange: function (event) { update({ defaultEffort: event.target.value }) } },
                  h('option', { value: '' }, '选择默认档位'), draft.allowedEfforts.map(function (id) { return h('option', { key: id, value: id }, id) })))) : null),
          h('section', { style: { marginTop: '18px' } },
            h('h3', null, '3. 执行权限'),
            permissionOption('full-access', '完全权限（需确认）', '执行会话切换到完全权限，不弹审批；允许工作区外读写与不受限命令，仅对可信任务开启'),
            state.permissions && state.permissions.autoAvailable ? permissionOption('auto', '自动审核', '完全权限 + DSH Auto 审核：每个受限动作由自动审查决定是否放行（实验能力）') : null,
            permissionOption('never-ask', '不询问', '保留 profile 的工作区限制；遇到需要人工批准的动作直接拒绝，不会卡住，也不会自动放行'),
            permissionOption('inherit', '沿用 DSH 默认权限（新安装默认）', '保持 profile 默认；需要批准时执行会停在输入等待，无人值守的任务可能中断'),
            draft.permissionMode === 'full-access' ? h('div', { style: { margin: '8px 0 0 26px' } },
              h('p', { style: { color: '#e3b871', fontSize: '11px', lineHeight: 1.7, margin: '0 0 6px' } },
                '完全权限允许该执行会话读写工作区外文件、运行不受工作区限制的命令。请确认你接受这个风险。'),
              h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '11px' } },
                h('input', { type: 'checkbox', 'aria-label': '确认完全权限', checked: Boolean(draft.fullAccessAck), onChange: function (event) { update({ fullAccessAck: event.target.checked }) } }),
                '我理解风险，允许该桥的执行会话使用完全权限')) : null),
          h('section', { style: { marginTop: '22px', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
            h('button', { type: 'button', className: 'cb-btn cbn-open-native', disabled: busy || (draft.modelMode === 'pinned' && (!draft.provider || !draft.model)) || (draft.permissionMode === 'full-access' && !draft.fullAccessAck), onClick: save }, busy ? '保存中…' : '保存执行模型设置'),
            h('button', { type: 'button', className: 'cb-btn', disabled: busy, onClick: load }, '重新读取 DSH 目录'),
            h('small', { style: { opacity: 0.7 } }, '当前生效：' + currentRoute.provider + '/' + currentRoute.model + ' · ' + state.policy.effortMode + ' · ' + ({ 'never-ask': '执行权限不询问', inherit: '执行权限沿用 profile', 'full-access': '完全权限' }[state.policy.permissionMode] || '执行权限未设置'))),
          h('p', { className: 'cbn-index-foot', style: { marginTop: '18px' } }, '模型 ID、思考档位和提供商都来自 DSH 当前目录。模型源或模型改名后，刷新本页重新选择即可，无需改插件代码。若保存的模型被移除，执行会明确失败，不会悄悄换成别的模型。'))
      }
      return h('div', { className: 'cbn-detail-content' }, view)
    }

    function NativeWorkbench() {
      var viewPair = useState(nativeWorkbench.view), view = viewPair[0], setView = viewPair[1]
      function select(value) { nativeWorkbench.view = value; setView(value) }
      return h('div', { className: 'cbn-workbench' },
        h('nav', { className: 'cbn-tabs', 'aria-label': 'Codex 工作台视图' },
          h('strong', null, 'Codex × DSH'),
          h('button', { type: 'button', className: view === 'executions' ? 'active' : '', 'aria-pressed': view === 'executions', onClick: function () { select('executions') } }, 'DSH 执行会话'),
          h('button', { type: 'button', className: view === 'codex' ? 'active' : '', 'aria-pressed': view === 'codex', onClick: function () { select('codex') } }, 'Codex 项目 / 只读'),
          h('button', { type: 'button', className: view === 'settings' ? 'active' : '', 'aria-pressed': view === 'settings', onClick: function () { select('settings') } }, '执行模型')),
        view === 'executions' ? h(NativeExecutions) : view === 'settings' ? h(ModelPolicySettings) : h(CodexMirrorPage))
    }

    function CodexMirrorPage() {
      var projectsState = useState(null)
      var projects = projectsState[0]
      var setProjects = projectsState[1]
      var loadingState = useState(true)
      var loading = loadingState[0]
      var setLoading = loadingState[1]
      var errorState = useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var activeState = useState(nativeWorkbench.threadId)
      var activeId = activeState[0]
      var setActiveId = activeState[1]
      var threadState = useState(null)
      var thread = threadState[0]
      var setThread = threadState[1]
      var messagesState = useState([])
      var messages = messagesState[0]
      var setMessages = messagesState[1]
      var threadLoadingState = useState(false)
      var threadLoading = threadLoadingState[0]
      var setThreadLoading = threadLoadingState[1]
      var draftState = useState('')
      var draft = draftState[0]
      var setDraft = draftState[1]
      var sendingState = useState(false)
      var sending = sendingState[0]
      var setSending = sendingState[1]
      var sendErrorState = useState('')
      var sendError = sendErrorState[0]
      var setSendError = sendErrorState[1]
      var usageState = useState(null)
      var usage = usageState[0]
      var setUsage = usageState[1]
      var queryState = useState('')
      var query = queryState[0]
      var setQuery = queryState[1]

      var loadProjects = useCallback(function () {
        return fetch(CX_PROJECTS, { credentials: 'same-origin', cache: 'no-store' })
          .then(cxJson)
          .then(function (next) {
            setProjects(next)
            setError('')
            return next
          })
          .catch(function (cause) {
            setError(String((cause && cause.message) || cause))
            return null
          })
          .then(function (value) {
            setLoading(false)
            return value
          })
      }, [])

      var openThread = useCallback(function (id) {
        if (!id) return
        nativeWorkbench.threadId = id
        setActiveId(id)
        setThread(null)
        setMessages([])
        setThreadLoading(true)
        setSendError('')
        setUsage(null)
        fetch(CX_THREAD + '?id=' + encodeURIComponent(id), { credentials: 'same-origin', cache: 'no-store' })
          .then(cxJson)
          .then(function (next) {
            if (nativeWorkbench.threadId !== id) return
            setThread(next.thread)
            setMessages((next.thread && next.thread.turns ? next.thread.turns : []).map(function (turn) {
              return { role: turn.role === 'user' ? 'user' : 'assistant', text: turn.text || '' }
            }))
          })
          .catch(function (cause) {
            if (nativeWorkbench.threadId !== id) return
            setThread(null)
            setMessages([])
            setSendError(String((cause && cause.message) || cause))
          })
          .then(function () {
            if (nativeWorkbench.threadId === id) setThreadLoading(false)
          })
      }, [])

      useEffect(function () {
        loadProjects().then(function (value) {
          if (!value || !value.projects || value.projects.length === 0) return
          var preferred = value.projects.reduce(function (found, project) { return found || (project.threads || []).find(function (item) { return item.id === nativeWorkbench.threadId }) }, null)
          var first = preferred || (value.projects[0].threads && value.projects[0].threads[0])
          if (first) openThread(first.id)
        })
        var timer = setInterval(function () { loadProjects() }, 15000)
        return function () { clearInterval(timer) }
      }, [loadProjects, openThread])

      // Codex App remains the writer; this panel only reads transcripts.

      var visibleProjects = (projects && projects.projects ? projects.projects : []).map(function (project) {
        var term = query.trim().toLowerCase()
        var threads = term === ''
          ? project.threads
          : project.threads.filter(function (item) {
              return String(item.name).toLowerCase().indexOf(term) >= 0 || String(project.name).toLowerCase().indexOf(term) >= 0
            })
        return Object.assign({}, project, { visibleThreads: threads })
      }).filter(function (project) { return project.visibleThreads.length > 0 })
      var totalThreads = visibleProjects.reduce(function (total, project) { return total + project.visibleThreads.length }, 0)

      var side = h(
        'aside',
        { className: 'cx-side' },
        h(
          'div',
          { className: 'cx-side-head' },
          h('span', { className: 'cx-side-title' }, 'Codex 项目'),
          h('span', { className: 'cx-side-count' }, totalThreads + ' 个会话'),
          h('button', { className: 'cb-btn cb-btn-ghost', type: 'button', onClick: function () { setLoading(true); loadProjects().then(function () { setLoading(false) }) }, disabled: loading }, loading ? '…' : '刷新'),
        ),
        h(
          'div',
          { className: 'cx-search' },
          h('input', { value: query, placeholder: '搜索项目或会话', onChange: function (event) { setQuery(event.target.value) } }),
        ),
        h(
          'div',
          { className: 'cx-tree' },
          error ? h('div', { className: 'cb-error cx-error' }, error) : null,
          visibleProjects.length === 0
            ? h('div', { className: 'cx-empty' }, h('b', null, loading ? '读取中…' : '没有匹配的会话'), h('span', null, '项目与会话来自本机 Codex。'))
            : visibleProjects.map(function (project) {
                return h(
                  'div',
                  { className: 'cx-project', key: project.cwd || project.name },
                  h(
                    'div',
                    { className: 'cx-project-head', title: project.cwd },
                    h('span', { className: 'cx-project-name' }, project.name),
                    h('span', { className: 'cx-project-count' }, project.visibleThreads.length),
                  ),
                  project.visibleThreads.map(function (item) {
                    var active = item.id === activeId
                    return h(
                      'div',
                      {
                        className: 'cx-thread' + (active ? ' cx-thread-active' : ''),
                        key: item.id,
                        role: 'button',
                        tabIndex: 0,
                        onClick: function () { openThread(item.id) },
                      },
                      h('span', { className: 'cx-thread-name', title: item.name }, item.name),
                      h('span', { className: 'cx-thread-meta' }, fmtClock(item.updatedAt || item.createdAt) + (item.model ? ' · ' + item.model : '')),
                    )
                  }),
                )
              }),
        ),
      )

      var transcript = thread
        ? messages.map(function (message, index) {
            return h(CodexBubble, { key: index, role: message.role, text: message.text })
          })
        : null
      var main = h(
        'section',
        { className: 'cx-main' },
        h(
          'header',
          { className: 'cx-main-head' },
          h('div', { className: 'cx-main-title' }, thread ? thread.name || '（未命名会话）' : '选择一个 Codex 会话'),
          h(
            'div',
            { className: 'cx-main-sub' },
            thread ? h('span', { className: 'cb-code', style: { display: 'inline-block' } }, thread.cwd || '—') : null,
            thread ? h('span', { className: 'cx-badge' }, '只读 · 请在 Codex App 下达任务') : null,
            threadLoading ? h('span', null, '读取中…') : null,
          ),
        ),
        sendError ? h('div', { className: 'cb-error cx-error', role: 'alert' }, '读取会话失败：' + sendError, h('button', { type: 'button', className: 'cb-btn', onClick: function () { openThread(activeId) } }, '重试')) : null,
        thread
          ? h('div', { className: 'cx-scroll' }, transcript)
          : h('div', { className: 'cx-empty' }, h('b', null, loading ? '读取 Codex 项目…' : '选择左侧一个会话'), h('span', null, '这里只读本机 Codex 的项目与会话；任务请在 Codex App 下达。')),

      )

      return h('div', { className: 'cx-page' }, side, main)
    }

    var LEDGER_API = '/api/dsh-codex-bridge.v2.codex'
    var bridgeUI = { kind: '', id: '', query: '', tab: 'conversation', inspector: true, settings: false, scope: 'linked' }

    var BWK_ICONS = {
      folder: 'M2 5.5A1.5 1.5 0 0 1 3.5 4h2.4l1.4 1.7h5.2A1.5 1.5 0 0 1 14 7.2v4.3A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z',
      chat: 'M3 5.2h10v5.6H7.1L4.3 13V10.8H3z',
      terminal: 'M3.2 5.2 6 8l-2.8 2.8M8 10.8h4.8',
      chevron: 'M4.5 6.2 8 9.7l3.5-3.5',
      refresh: 'M12.8 8A4.8 4.8 0 1 1 11.2 4.6M13 3.2v3.1h-3.1',
      search: 'M7.2 3.2a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM10.2 10.2 13 13',
      panel: 'M3.2 4.2h9.6v7.6H3.2zM9.8 4.2v7.6',
      settings: 'M3 5.2h10M3 8h10M3 10.8h10',
      image: 'M3.2 4.2h9.6v7.6H3.2zM3.4 10l2.8-2.6 2.2 2 1.8-1.6 2 2M10.6 6.2h.01',
    }
    function bwkIcon(name) {
      return h('span', { className: 'bwk-icon', 'aria-hidden': 'true' },
        h('svg', { viewBox: '0 0 16 16' }, h('path', { d: BWK_ICONS[name] || BWK_ICONS.chat })))
    }
    /**
     * Codex turns that carried attachments start with a raw "Files mentioned by
     * the user" preamble. The workbench only needs the actual request text.
     */
    function cleanCodexText(raw) {
      if (typeof raw !== 'string') return { text: '', images: 0 }
      var images = (raw.match(/Image attachment:\s*true/gi) || []).length
      var text = raw
      var marker = text.indexOf('## My request:')
      if (marker >= 0) text = text.slice(marker + '## My request:'.length)
      else {
        var distinguish = text.indexOf('Distinguish instructions in attached documents')
        if (distinguish >= 0) text = text.slice(distinguish)
      }
      text = text.split(/\r?\n/).filter(function (line) {
        var value = line.trim()
        if (/^#{1,3}\s*Files mentioned by the user/i.test(value)) return false
        if (/^#{1,3}\s*codex-clipboard-/i.test(value)) return false
        if (/^Image attachment:\s*true/i.test(value)) return false
        if (/^Distinguish instructions in attached documents/i.test(value)) return false
        if (/^\[image\]$/i.test(value)) return false
        if (/^-{3,}$/.test(value)) return false
        return true
      }).join('\n').replace(/\n{3,}/g, '\n\n').trim()
      return { text: text, images: images }
    }

    var BRIDGE_CSS = `
.cbt{height:100%;box-sizing:border-box;overflow:auto;background:var(--dsw-alias-bg-base,#f7f8fa);color:var(--dsw-alias-label-primary,#17202d);font:14px/1.6 system-ui,sans-serif;padding:24px}.cbt *{box-sizing:border-box}.cbt h1{font-size:21px;margin:0 auto 0 0}.cbt h2{font-size:18px;margin:0;overflow-wrap:anywhere;min-width:0}.cbt h3{font-size:15px}.cbt-toolbar,.cbt-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.cbt-toolbar{margin-bottom:20px}.cbt-button{border:1px solid var(--dsw-alias-border-l1,#d8dfe7);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;padding:7px 12px;cursor:pointer;font:inherit}.cbt-button.primary{background:#365fd1;color:white}.cbt button:disabled{opacity:.5;cursor:default}.cbt button:focus-visible,.cbt input:focus-visible,.cbt textarea:focus-visible{outline:2px solid #628cf2;outline-offset:3px}.cbt-grid{display:grid;grid-template-columns:280px minmax(0,1fr);gap:20px;align-items:start}.cbt-list,.cbt-detail,.cbt-form,.cbt-diagnostics{padding:20px;border:1px solid var(--dsw-alias-border-l1,#d8dfe7);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}.cbt-detail{min-width:0}.cbt-list{padding:12px}.cbt label{display:flex;flex-direction:column;gap:5px;margin:10px 0}.cbt input:not([type=checkbox]):not([type=radio]),.cbt textarea{width:100%;padding:9px;border:1px solid var(--dsw-alias-border-l1,#d8dfe7);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit}.cbt textarea{min-height:96px;resize:vertical}.cbt .cbt-check{flex-direction:row;align-items:center;gap:8px}.cbt-task{display:flex;flex-direction:column;gap:5px;text-align:left;width:100%;padding:12px;margin:8px 0;border:1px solid transparent;border-radius:7px;background:transparent;color:inherit;cursor:pointer;font:inherit}.cbt-task.selected{border-color:#628cf2;background:var(--dsw-alias-bg-layer-2,#f1f4f9)}.cbt-task strong{font-size:13px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.cbt-task small,.cbt-muted{font-size:12px;color:var(--dsw-alias-label-secondary,#637083);overflow-wrap:anywhere}.cbt pre,.cbt code{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,monospace}.cbt pre{padding:14px;background:var(--dsw-alias-bg-layer-2,#f1f4f9);border-radius:6px}.cbt code{display:block}.cbt dl{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px;margin:20px 0}.cbt dd{margin:0;overflow-wrap:anywhere}.cbt dt{color:var(--dsw-alias-label-secondary,#637083)}.cbt-form,.cbt-diagnostics{margin-bottom:20px}.cbt-notice{padding:12px;background:var(--dsw-alias-bg-layer-2,#f1f4f9);border-radius:6px}.cbt-error{padding:12px;border:1px solid #b94343;border-radius:6px}.cbt-empty{padding:60px 20px;text-align:center}.cbt fieldset{border:1px solid var(--dsw-alias-border-l1,#d8dfe7);border-radius:6px;margin:12px 0}.cbt summary{cursor:pointer;padding:8px 0}@media(max-width:760px){.cbt{padding:14px}.cbt-grid{grid-template-columns:minmax(0,1fr)}.cbt-list{max-height:300px;overflow:auto}.cbt-toolbar{gap:8px}.cbt-detail,.cbt-form{padding:14px}.cbt dl{grid-template-columns:90px minmax(0,1fr)}}

.bwk{--bwk-accent:#4f7cf7;--bwk-ok:#3fae87;--bwk-warn:#d19a3c;--bwk-err:#e06b6b;display:grid;grid-template-columns:272px minmax(0,1fr) 344px;position:relative;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}
.bwk *{box-sizing:border-box}
.bwk button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.bwk-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:0 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;font-size:12px;color:var(--dsw-alias-label-primary);white-space:nowrap;transition:background .12s ease,border-color .12s ease}
.bwk-btn:hover{background:var(--dsw-alias-bg-layer-1)}
.bwk-btn.primary{background:var(--bwk-accent);border-color:var(--bwk-accent);color:#fff}
.bwk-btn.primary:hover{background:#3f6ae0}
.bwk-btn.ghost{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.bwk-btn.small{min-height:26px;padding:0 9px;font-size:11px;border-radius:7px}
.bwk-btn:disabled{opacity:.5;cursor:not-allowed}
.bwk-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:0 0 14px}
.bwk-icon svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.bwk-nav{background:var(--dsw-alias-bg-layer-1);border-right:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0}
.bwk-nav-head{padding:16px 14px 10px;display:flex;align-items:center;gap:8px}
.bwk-brandmark{width:22px;height:22px;border-radius:6px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);display:grid;place-items:center;font-size:11px;font-weight:700;flex:0 0 22px}
.bwk-nav-head strong{font-size:13px;font-weight:650;letter-spacing:.1px}
.bwk-nav-head small{margin-left:auto;font-size:10px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.bwk-search{margin:0 12px 10px;padding:0 10px;height:32px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;display:flex;gap:7px;background:var(--dsw-alias-bg-base);align-items:center;color:var(--dsw-alias-label-secondary)}
.bwk-search input{flex:1;min-width:0;background:none;border:0;outline:none;color:var(--dsw-alias-label-primary);font-size:12px}
.bwk-scope{display:flex;gap:4px;padding:0 12px 10px}
.bwk-scope button{flex:1;height:26px;border-radius:7px;font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid transparent}
.bwk-scope button:hover{background:var(--dsw-alias-bg-base)}
.bwk-scope button.active{background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-weight:600}
.bwk-scope button small{margin-left:4px;font-weight:400;opacity:.65}
.bwk-tree{flex:1;overflow:auto;padding:0 8px 26px;scrollbar-width:thin}
.bwk-project{margin-bottom:2px}
.bwk-proj{height:32px;padding:0 8px;display:flex;align-items:center;gap:8px;border-radius:7px;font-size:12px;font-weight:600;width:100%;text-align:left;color:var(--dsw-alias-label-primary)}
.bwk-proj:hover{background:var(--dsw-alias-bg-base)}
.bwk-proj .bwk-icon{color:var(--dsw-alias-label-secondary)}
.bwk-proj-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bwk-count{font-size:10px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:0 6px;line-height:16px}
.bwk-children{padding:2px 0 6px 12px;margin-left:14px;border-left:1px solid var(--dsw-alias-border-l1)}
.bwk-row{display:flex;gap:8px;align-items:flex-start;width:100%;text-align:left;padding:6px 8px;border-radius:7px;margin:1px 0}
.bwk-row:hover{background:var(--dsw-alias-bg-base)}
.bwk-row.selected{background:var(--dsw-alias-bg-base);box-shadow:inset 2px 0 0 var(--bwk-accent)}
.bwk-row-main{min-width:0;flex:1}
.bwk-row-name{display:block;font-size:12px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bwk-row-meta{display:flex;gap:5px;font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bwk-more{margin:6px 0 2px;padding:5px 8px;border-radius:7px;font-size:11px;color:var(--bwk-accent);text-align:left;width:100%}
.bwk-more:hover{background:var(--dsw-alias-bg-base);text-decoration:underline}
.bwk-dot{width:6px;height:6px;border-radius:50%;margin-top:7px;flex:0 0 6px;background:var(--dsw-alias-label-secondary)}
.bwk-dot.ok{background:var(--bwk-ok)}.bwk-dot.run{background:var(--bwk-accent)}.bwk-dot.warn{background:var(--bwk-warn)}.bwk-dot.err{background:var(--bwk-err)}
.bwk-dot.thread{background:transparent;border:1.5px solid var(--dsw-alias-label-secondary);margin-top:6px;width:7px;height:7px;flex-basis:7px}
.bwk-main{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base)}
.bwk-top{display:flex;align-items:center;gap:12px;padding:0 18px;height:54px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-shrink:0;font-size:12px}
.bwk-crumb{display:flex;align-items:center;gap:7px;min-width:0;color:var(--dsw-alias-label-secondary)}
.bwk-crumb .bwk-icon{opacity:.8}
.bwk-crumb b{color:var(--dsw-alias-label-primary);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px}
.bwk-actions{margin-left:auto;display:flex;gap:6px;align-items:center;flex-shrink:0}
.bwk-scroll{flex:1;overflow:auto;min-height:0;min-width:0;scrollbar-width:thin}
.bwk-content{box-sizing:border-box;width:100%;max-width:792px;margin:0 auto;padding:30px 38px 56px;min-width:0}
.bwk-eyebrow{font-size:10px;letter-spacing:.7px;text-transform:uppercase;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bwk-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.bwk-status:before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}
.bwk-status.ok{color:var(--bwk-ok)}.bwk-status.warn{color:var(--bwk-warn)}.bwk-status.err{color:var(--bwk-err)}.bwk-status.run{color:var(--bwk-accent)}
.bwk-title{font-size:21px;line-height:1.4;font-weight:650;margin:10px 0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.bwk-context{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);align-items:center;overflow-wrap:anywhere;min-width:0}
.bwk-tabs{display:flex;gap:24px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-top:20px}
.bwk-tab{padding:11px 1px;font-size:12px;color:var(--dsw-alias-label-secondary);border-bottom:2px solid transparent;margin-bottom:-1px}
.bwk-tab:hover{color:var(--dsw-alias-label-primary)}
.bwk-tab.active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--bwk-accent);font-weight:600}
.bwk-msgs{padding:22px 0 6px}
.bwk-msg{display:flex;gap:11px;padding:12px 0}
.bwk-avatar{width:24px;height:24px;border-radius:7px;flex:0 0 24px;display:grid;place-items:center;font-size:11px;font-weight:600;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.bwk-msg.user .bwk-avatar{background:var(--bwk-accent);color:#fff;border-color:transparent}
.bwk-msg-body{min-width:0;flex:1}
.bwk-msg-role{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:3px;display:flex;gap:8px;align-items:center}
.bwk-msg-text{font-size:13px;line-height:1.78;white-space:pre-wrap;overflow-wrap:anywhere}
.bwk-msg.user .bwk-msg-text{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 15px}
.bwk-attach{display:inline-flex;align-items:center;gap:5px;margin-top:6px;font-size:10px;color:var(--dsw-alias-label-secondary)}
.bwk-note{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:13px 15px;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.75;margin:18px 0}
.bwk-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:16px;margin:14px 0;background:var(--dsw-alias-bg-layer-1)}
.bwk-card h3{margin:0 0 6px;font-size:12px;font-weight:600}
.bwk-result{font-size:13px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.bwk-tag{display:inline-flex;align-items:center;padding:1px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;line-height:16px}
.bwk-tag.blue{border-color:transparent;background:rgba(79,124,247,.18);color:#9db8ff}
.bwk-inspector{background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0}
.bwk.no-inspector{grid-template-columns:272px minmax(0,1fr)}
.bwk.no-inspector .bwk-inspector{display:none}
.bwk-inspector-head{height:54px;display:flex;align-items:center;gap:8px;padding:0 18px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;font-weight:600;flex-shrink:0}
.bwk-inspector-body{overflow:auto;padding:18px;scrollbar-width:thin}
.bwk-inspector h2{font-size:14px;line-height:1.5;margin:2px 0 8px;font-weight:650;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.bwk-desc{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.75;margin:0 0 16px;overflow-wrap:anywhere}
.bwk-dl{display:grid;grid-template-columns:62px minmax(0,1fr);gap:9px 12px;font-size:11px;line-height:1.6;margin:0}
.bwk-dl dt{color:var(--dsw-alias-label-secondary)}
.bwk-dl dd{margin:0;overflow-wrap:anywhere}
.bwk-rule{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:20px 0}
.bwk-section-title{font-size:10px;letter-spacing:.7px;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin-bottom:9px;display:flex;align-items:center;gap:7px}
.bwk-steps{list-style:none;margin:6px 0 0;padding:0}
.bwk-step{position:relative;padding:0 0 18px 24px;font-size:11px}
.bwk-step:before{content:"";position:absolute;left:5px;top:15px;bottom:0;width:1px;background:var(--dsw-alias-border-l1)}
.bwk-step:last-child:before{display:none}
.bwk-step-dot{position:absolute;left:0;top:3px;width:11px;height:11px;border-radius:50%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.bwk-step.done .bwk-step-dot{background:var(--bwk-ok);border-color:var(--bwk-ok)}
.bwk-step.active .bwk-step-dot{border-color:var(--bwk-accent);box-shadow:0 0 0 3px rgba(79,124,247,.18)}
.bwk-step-title{display:flex;gap:8px;align-items:baseline;font-weight:600;color:var(--dsw-alias-label-primary)}
.bwk-step-title small{color:var(--dsw-alias-label-secondary);font-size:10px;margin-left:auto;font-weight:400}
.bwk-step p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);line-height:1.7;overflow-wrap:anywhere}
.bwk-related{display:flex;flex-direction:column;gap:7px}
.bwk-mini{display:flex;gap:9px;font-size:11px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;text-align:left;align-items:flex-start;width:100%;background:var(--dsw-alias-bg-base)}
.bwk-mini:hover{border-color:var(--bwk-accent)}
.bwk-mini span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bwk-empty{padding:48px 24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.8}
.bwk-empty b{display:block;color:var(--dsw-alias-label-primary);font-size:13px;margin-bottom:6px}
.bwk-overlay{position:absolute;inset:0;z-index:20;background:rgba(6,10,18,.6);display:flex;justify-content:flex-end;backdrop-filter:blur(2px)}
.bwk-modal{width:min(760px,100%);height:100%;background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0;box-shadow:-24px 0 80px rgba(0,0,0,.4)}
.bwk-modal-head{height:54px;display:flex;align-items:center;gap:8px;padding:0 20px;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:600;flex-shrink:0}
.bwk-modal-body{flex:1;overflow:auto;padding:24px}
.bwk-err{border:1px solid rgba(224,107,107,.45);background:rgba(224,107,107,.1);color:#f2b3b3;border-radius:8px;padding:10px 13px;font-size:11px;line-height:1.7;margin:12px 0}
.bwk-inspector-toggle{display:inline-flex}
@media (max-width:1240px){.bwk{grid-template-columns:248px minmax(0,1fr)}.bwk-inspector{display:none}.bwk-inspector.open{display:flex;position:absolute;right:0;top:0;bottom:0;width:min(368px,86vw);z-index:15;box-shadow:-20px 0 60px rgba(0,0,0,.4)}}
@media (max-width:860px){.bwk{grid-template-columns:minmax(0,1fr)}.bwk-nav{display:none}.bwk-content{padding:22px 18px 44px}.bwk-title{font-size:19px}}
`

    function bwkJson(res) {
      return res.json().then(function (body) {
        if (!res.ok || (body && body.ok === false)) throw new Error((body && (body.message || body.error)) || 'HTTP ' + res.status)
        return body
      }, function () { throw new Error('HTTP ' + res.status) })
    }
    function bwkStatus(record) {
      if (record && record.state === 'needs-input') return { key: 'warn', label: '等待 Codex 回答' }
      if (record && record.state === 'input-required') return { key: 'warn', label: '等待原生审批' }
      if (record && record.state === 'running') return { key: 'run', label: '执行中' }
      if (!record || !record.endedAt) return { key: 'warn', label: '状态待确认' }
      var reason = record.stopReason || ''
      if (reason === 'completed' || reason === 'idle') return { key: 'ok', label: '已完成' }
      if (reason === 'error') return { key: 'err', label: '执行出错' }
      if (reason === 'input-required') return { key: 'warn', label: '当时等待输入' }
      return { key: 'warn', label: reason ? '已中断 / ' + reason : '已中断' }
    }
    function bwkEffortSource(source) {
      return ({
        'dsh-default': '跟随 DSH 默认',
        'model-default': '模型默认档',
        'adapter-default': '适配器默认',
        'policy-fixed': '政策固定',
        'policy-default': '政策默认档',
        caller: 'Codex 按政策选择',
      })[source] || source || '未记录'
    }
    function bwkTaskOf(record) {
      var text = record && typeof record.task === 'string' ? record.task.trim() : ''
      if (text === '') return '未记录任务'
      return text.length > 120 ? text.slice(0, 120) + '…' : text
    }
    function bwkMiniRow(record, onOpen) {
      var status = bwkStatus(record)
      return h('button', { type: 'button', className: 'bwk-mini', key: record.sessionId, onClick: function () { onOpen(record) } },
        h('span', { className: 'bwk-dot ' + status.key, style: { marginTop: '5px' } }),
        h('span', { style: { flex: 1 } },
          h('span', { className: 'bwk-row-name' }, bwkTaskOf(record)),
          h('span', { className: 'bwk-row-meta' }, 'DSH · ' + status.label + ' · ' + fmtWhen(record.startedAt))))
    }

    function TaskWorkbench(props) {
      var state = useState({tasks:[], nextCursor:null}), listing = state[0], setListing = state[1]
      var detailState = useState(null), task = detailState[0], setTask = detailState[1]
      var eventsState = useState([]), events = eventsState[0], setEvents = eventsState[1]
      var diagnosticsState = useState(null), diagnostics = diagnosticsState[0], setDiagnostics = diagnosticsState[1]
      var errorState = useState(''), error = errorState[0], setError = errorState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var formState = useState(false), showForm = formState[0], setShowForm = formState[1]
      var draftState = useState({goal:'',cwd:'',plan:'',acceptance:'',seconds:300,review:false,verificationProfile:''}), draft = draftState[0], setDraft = draftState[1]
      var filterState = useState(''), filter = filterState[0], setFilter = filterState[1]
      var pageState = useState(0), pageCursor = pageState[0], setPageCursor = pageState[1]
      var historyState = useState(''), historyId = historyState[0], setHistoryId = historyState[1]
      var answersState = useState({}), answers = answersState[0], setAnswers = answersState[1]
      var acceptState = useState(false), accepted = acceptState[0], setAccepted = acceptState[1]
      var selected = React.useRef(''), alive = React.useRef(true), generation = React.useRef(0), submissionKey = React.useRef(''), retryKeys = React.useRef({}), eventCursor = React.useRef(0)
      var labels = {QUEUED:'排队中',RUNNING:'执行中',VERIFYING:'验证中',WAITING_INPUT:'等待回答',WAITING_APPROVAL:'等待原生审批',CANCEL_REQUESTED:'正在确认停止',RECONCILING:'等待对账',REVIEW_REQUIRED:'待人工核对',SUCCEEDED:'验收通过',FAILED:'失败',CANCELLED:'已取消',LEGACY:'旧版只读记录'}
      function request(action, input) {
        var controller = new AbortController(), timer = setTimeout(function(){controller.abort()},25000)
        return fetch('/api/dsh-codex-bridge.v2.task-workbench',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({},input||{},{action:action})),signal:controller.signal})
          .then(function(response){return response.json().then(function(body){if(!response.ok||!body.ok)throw new Error(body.message||body.error||'请求失败');return body.value})})
          .finally(function(){clearTimeout(timer)})
      }
      function load() {
        var current = selected.current, ticket = ++generation.current
        return Promise.all([request('list',{cursor:pageCursor,limit:50}), current ? request('get',{taskId:current}) : Promise.resolve(null), current ? request('events',{taskId:current,cursor:eventCursor.current}) : Promise.resolve({events:[]})])
          .then(function(result){if(!alive.current||ticket!==generation.current)return;setListing(result[0]);setTask(result[1]);eventCursor.current=result[2].cursor||eventCursor.current;setEvents(function(previous){var seen=new Set(previous.map(function(item){return item.eventId}));return previous.concat(result[2].events.filter(function(item){return !seen.has(item.eventId)}))});setError('')})
          .catch(function(cause){if(alive.current&&ticket===generation.current)setError('连接或读取失败：'+cause.message+'。保留当前记录，刷新不会重新执行任务。')})
      }
      useEffect(function(){alive.current=true;load();var timer=setInterval(load,5000);return function(){alive.current=false;generation.current++;clearInterval(timer)}},[pageCursor])
      useEffect(function(){setAnswers({})},[task&&task.activeRunId,task&&task.run&&task.run.question&&task.run.question.requestId])
      useEffect(function(){setAccepted(false)},[task&&task.revision,task&&task.run&&task.run.evidenceHash])
      function choose(id){selected.current=id;eventCursor.current=0;setEvents([]);setHistoryId('');setAccepted(false);setTask(null);load()}
      function operate(action,input) {
        if(busy)return Promise.resolve()
        setBusy(true);setError('')
        return request(action,input).then(function(result){if(!alive.current)return;if(result&&result.taskId){if(selected.current!==result.taskId){eventCursor.current=0;setEvents([])}selected.current=result.taskId;setTask(result)}if(action==='importLegacy')setDiagnostics(null);return load()})
          .catch(function(cause){if(alive.current)setError(cause.message+(action==='submit'?'。提交结果未确认；保留提交编号，重试会关联原任务。':''))})
          .finally(function(){if(alive.current)setBusy(false)})
      }
      function field(key,value){setDraft(Object.assign({},draft,((function(){var patch={};patch[key]=value;return patch})())))}
      function submit(event) {
        event.preventDefault()
        if(!submissionKey.current)submissionKey.current=crypto.randomUUID()
        var input={goal:draft.goal,cwd:draft.cwd||undefined,plan:draft.plan,acceptance:draft.acceptance.split('\n').filter(Boolean),timeoutMs:Number(draft.seconds)*1000,review:draft.review,idempotencyKey:submissionKey.current}
        if(draft.verificationProfile)input.verificationProfile=draft.verificationProfile
        setBusy(true);setError('')
        request('submit',input).then(function(result){if(!alive.current)return;selected.current=result.taskId;eventCursor.current=0;setEvents([]);setTask(result);submissionKey.current='';setShowForm(false);setDraft(Object.assign({},draft,{goal:''}));return load()})
          .catch(function(cause){if(alive.current)setError(cause.message+'。提交结果未确认，请保留编号并以相同内容重试。')})
          .finally(function(){if(alive.current)setBusy(false)})
      }
      function diagnose(){request('diagnose').then(function(value){if(alive.current)setDiagnostics(value)}).catch(function(cause){if(alive.current)setError(cause.message)})}
      function openSession(){if(nativeOpen&&task&&task.run.sessionId)Promise.resolve(nativeOpen(task.run.sessionId)).catch(function(cause){setError(cause.message)})}
      var run = task && ((task.history||[]).find(function(item){return item.runId===historyId}) || task.run)
      var currentRun = !historyId || task && task.activeRunId===historyId
      var editable = task && !task.legacy && currentRun
      var terminalTask = task && ['SUCCEEDED','FAILED','CANCELLED','REVIEW_REQUIRED','LEGACY'].includes(task.state)
      var visible = listing.tasks.filter(function(item){return (item.goal+' '+item.cwd+' '+item.taskId).toLowerCase().includes(filter.toLowerCase())})
      function button(text,fn,disabled,extra){return h('button',Object.assign({type:'button',className:'cbt-button',onClick:fn,disabled:disabled},extra||{}),text)}
      var form = showForm ? h('form',{className:'cbt-form',onSubmit:submit},h('h2',null,'新建任务'),
        h('label',null,'任务目标',h('textarea',{required:true,maxLength:20000,value:draft.goal,onChange:function(e){field('goal',e.target.value)}})),
        h('label',null,'工作目录',h('input',{value:draft.cwd,placeholder:'留空使用宿主默认目录',onChange:function(e){field('cwd',e.target.value)}})),
        h('details',null,h('summary',null,'计划与验收条件'),h('label',null,'计划',h('textarea',{maxLength:20000,value:draft.plan,onChange:function(e){field('plan',e.target.value)}})),h('label',null,'验收条件（每行一项）',h('textarea',{value:draft.acceptance,onChange:function(e){field('acceptance',e.target.value)}}))),
        h('div',{className:'cbt-row'},h('label',null,'总预算（秒，包含等待）',h('input',{type:'number',min:1,max:600,required:true,value:draft.seconds,onChange:function(e){field('seconds',e.target.value)}})),
          h('label',null,'验证配置名称',h('input',{value:draft.verificationProfile,placeholder:'用户预设的 profile 名称',onChange:function(e){field('verificationProfile',e.target.value)}}))),
        h('label',{className:'cbt-check'},h('input',{type:'checkbox',checked:draft.review,onChange:function(e){field('review',e.target.checked)}}),'执行结束后调用 Codex 审查'),
        submissionKey.current?h('p',{className:'cbt-muted'},'提交编号：'+submissionKey.current):null,
        h('button',{className:'cbt-button primary',type:'submit',disabled:busy||!draft.goal.trim()},busy?'正在提交…':'提交任务')):null
      var question=editable&&task.state==='WAITING_INPUT'&&run.question
      var questionForm=question?h('form',{className:'cbt-form',onSubmit:function(e){e.preventDefault();operate('answer',{taskId:task.taskId,runId:task.activeRunId,requestId:question.requestId,answers:question.questions.map(function(q){return {id:q.id,selected:answers[q.id]&&answers[q.id].selected||[],custom:answers[q.id]&&answers[q.id].custom||''}})})}},h('h3',null,'本次问题'),
        question.questions.map(function(q){return h('fieldset',{key:q.id},h('legend',null,q.question),(q.options||[]).map(function(option){var chosen=answers[q.id]&&answers[q.id].selected||[];return h('label',{key:option.label,className:'cbt-check'},h('input',{type:q.multiSelect?'checkbox':'radio',name:question.requestId+q.id,checked:chosen.includes(option.label),onChange:function(){var next=Object.assign({},answers);next[q.id]=Object.assign({},next[q.id],{selected:q.multiSelect?(chosen.includes(option.label)?chosen.filter(function(v){return v!==option.label}):chosen.concat(option.label)):[option.label]});setAnswers(next)}}),option.label)}),h('label',null,'补充回答',h('input',{value:answers[q.id]&&answers[q.id].custom||'',onChange:function(e){var next=Object.assign({},answers);next[q.id]=Object.assign({},next[q.id],{custom:e.target.value});setAnswers(next)}})))}),h('button',{className:'cbt-button primary',type:'submit',disabled:busy},'回答并继续')):null
      var body=task?h('article',{className:'cbt-detail'},h('div',{className:'cbt-row'},h('h2',null,task.goal),h('span',{className:'cbt-status'},labels[task.state]||task.state)),
        h('p',{className:'cbt-muted'},task.cwd),h('p',{className:'cbt-muted'},task.taskId),
        task.legacy?h('p',{className:'cbt-notice'},'旧版只读快照：未记录 Run 和验收证据，不可从此记录重试。'):null,
        h('div',{className:'cbt-row'},button('打开原生会话',openSession,!task.run.sessionId),editable&&!terminalTask?button('请求取消',function(){operate('cancel',{taskId:task.taskId})},busy):null,
          editable&&['RECONCILING','WAITING_APPROVAL','CANCEL_REQUESTED'].includes(task.state)?button('对账 / 补发取消',function(){operate('reconcile',{taskId:task.taskId})},busy):null,
          editable&&terminalTask?button('创建修复 Run',function(){if(window.confirm('创建新的修复 Run，将复用本任务上下文并受两轮上限约束。'))operate('retry',{taskId:task.taskId,idempotencyKey:retryKeys.current[task.taskId+task.activeRunId]||(retryKeys.current[task.taskId+task.activeRunId]=crypto.randomUUID())})},busy||run.attempt>=3):null),
        task.state==='WAITING_APPROVAL'?h('p',{className:'cbt-notice'},'请打开原生会话处理审批，然后对账。不要重新提交原任务。'):null,
        ['RECONCILING','CANCEL_REQUESTED'].includes(task.state)?h('p',{className:'cbt-notice'},'停止尚未确认。同项目任务将继续等待；对账可能补发已经请求的取消。'):null,
        task.plan?h('details',null,h('summary',null,'计划与验收条件'),h('pre',null,task.plan),h('ul',null,(task.acceptance||[]).map(function(a,i){return h('li',{key:i},a)}))):null,
        h('nav',{className:'cbt-row','aria-label':'运行历史'},button('当前运行',function(){setHistoryId('')},!historyId),(task.history||[]).map(function(item){return button('Run '+item.attempt,function(){setHistoryId(item.runId)},false,{key:item.runId,'aria-pressed':historyId===item.runId})})),
        h('dl',null,h('dt',null,'执行结果'),h('dd',null,run.outcome||'尚未确认'),h('dt',null,'宿主结束原因'),h('dd',null,run.hostStopReason||'未记录'),h('dt',null,'验收状态'),h('dd',null,run.verification&&run.verification.status||'未记录'),h('dt',null,'执行模型'),h('dd',null,run.execution&&run.execution.selection?run.execution.selection.provider+'/'+run.execution.selection.model:'未记录'),h('dt',null,'Run'),h('dd',null,run.runId||'未记录')),
        run.observationError?h('p',{role:'alert'},'观察失败：'+run.observationError.message):null,
        h('h3',null,'结果与证据'),h('pre',null,task.legacy?task.legacySnapshot.text||'未记录':run.result&&run.result.text||'暂无文本结果'),
        h('ul',null,(run.verification&&run.verification.checks||[]).map(function(check,i){return h('li',{key:i},(check.path||(check.argv||[]).join(' ')||'验证命令')+' · '+(check.passed===true?'通过':check.passed===false?'失败':check.status||'未验证'))})),
        h('ul',null,(run.verification&&run.verification.artifacts||[]).map(function(item){return h('li',{key:item.path},item.path+' · '+item.bytes+' bytes',h('code',null,item.hash))})),
        run.review?h('p',null,'Codex 审查：'+run.review.verdict+' · '+(run.review.summary||'')):null,
        questionForm,
        editable&&task.state==='REVIEW_REQUIRED'?h('section',{className:'cbt-form'},h('h3',null,'人工验收'),h('label',{className:'cbt-check'},h('input',{type:'checkbox',checked:accepted,onChange:function(e){setAccepted(e.target.checked)}}),'我已核对当前 Run 的产物和验收证据'),button('接受当前结果',function(){operate('review',{taskId:task.taskId,runId:task.activeRunId,expectedRevision:task.revision,evidenceHash:run.evidenceHash,decision:'accept'})},busy||!accepted),button('要求修改',function(){operate('review',{taskId:task.taskId,runId:task.activeRunId,expectedRevision:task.revision,evidenceHash:run.evidenceHash,decision:'changes_requested'})},busy)):null,
        h('details',null,h('summary',null,'事件时间线 · '+events.length+' 项'),button('读取后续事件',load,busy),h('ol',null,events.map(function(item){return h('li',{key:item.eventId},new Date(item.at).toLocaleString()+' · '+item.type)})))):h('div',{className:'cbt-empty'},'选择任务查看运行记录、问题和验收证据。')
      return h('section',{className:'cbt','aria-label':'任务工作台'},h('header',{className:'cbt-toolbar'},button('返回会话',props.onBack,false),h('h1',null,'任务工作台'),button('新建任务',function(){setShowForm(!showForm)},busy,{'aria-expanded':showForm}),button('刷新',load,busy),button('诊断',diagnose,busy),button('导入旧记录',function(){if(window.confirm('将旧台账导入为只读快照，不重跑任务。请先结束活动任务。'))operate('importLegacy',{})},busy)),
        error?h('p',{className:'cbt-error',role:'alert'},error):null,
        diagnostics?h('section',{className:'cbt-diagnostics'},h('h2',null,'诊断'),h('p',null,'版本 '+diagnostics.version+' · 宿主 Node '+diagnostics.hostNode+' · 任务库 '+diagnostics.store.status),h('p',null,'真机验收：'+diagnostics.liveAcceptance),h('ul',null,Object.keys(diagnostics.capabilities).map(function(key){return h('li',{key:key},key+'：'+(diagnostics.capabilities[key]?'可用':'不可用 / 未确认'))}))):null,
        form,h('div',{className:'cbt-grid'},h('aside',{className:'cbt-list'},h('label',null,'筛选本页任务',h('input',{type:'search',value:filter,onChange:function(e){setFilter(e.target.value)}})),visible.length?visible.map(function(item){return h('button',{key:item.taskId,type:'button',className:'cbt-task'+(selected.current===item.taskId?' selected':''),'aria-pressed':selected.current===item.taskId,onClick:function(){choose(item.taskId)}},h('strong',null,item.goal),h('span',null,labels[item.state]||item.state),h('small',null,item.cwd))}):h('p',null,'本页没有匹配任务'),h('div',{className:'cbt-row'},button('上一页',function(){setPageCursor(Math.max(0,pageCursor-50))},pageCursor===0),button('下一页',function(){setPageCursor(listing.nextCursor)},listing.nextCursor===null))),body))
    }

    function BridgeWorkbench() {
      var workspaceState = useState(false), tasksVisible = workspaceState[0], setTasksVisible = workspaceState[1]
      var codexState = useState(null), codex = codexState[0], setCodex = codexState[1]
      var ledgerState = useState(null), ledger = ledgerState[0], setLedger = ledgerState[1]
      var selState = useState({ kind: bridgeUI.kind, id: bridgeUI.id }), sel = selState[0], setSel = selState[1]
      var queryState = useState(bridgeUI.query), query = queryState[0], setQuery = queryState[1]
      var tabState = useState(bridgeUI.tab), tab = tabState[0], setTab = tabState[1]
      var threadState = useState(null), thread = threadState[0], setThread = threadState[1]
      var threadBusyState = useState(false), threadBusy = threadBusyState[0], setThreadBusy = threadBusyState[1]
      var errorState = useState(''), error = errorState[0], setError = errorState[1]
      var navErrorState = useState(''), navError = navErrorState[0], setNavError = navErrorState[1]
      var noticeState = useState(''), notice = noticeState[0], setNotice = noticeState[1]
      var inspectorState = useState(bridgeUI.inspector), inspector = inspectorState[0], setInspector = inspectorState[1]
      var settingsState = useState(bridgeUI.settings), settings = settingsState[0], setSettings = settingsState[1]
      var collapsedState = useState({}), collapsed = collapsedState[0], setCollapsed = collapsedState[1]
      var scopeState = useState(bridgeUI.scope), scope = scopeState[0], setScope = scopeState[1]
      var expandedState = useState({}), expandedProjects = expandedState[0], setExpandedProjects = expandedState[1]
      var alive = React.useRef(true)

      function choose(kind, id) {
        bridgeUI.kind = kind
        bridgeUI.id = id
        bridgeUI.tab = 'conversation'
        setTab('conversation')
        setSel({ kind: kind, id: id })
        setNotice('')
        setError('')
        setNavError('')
      }
      function openNative(record) {
        if (!nativeOpen) {
          setNavError('原生会话导航服务尚未就绪，请刷新窗口。')
          return
        }
        setNavError('')
        Promise.resolve().then(function () { return nativeOpen(record.sessionId) })
          .catch(function (cause) { setNavError('无法打开原生会话：' + String((cause && cause.message) || cause)) })
      }
      var load = useCallback(function () {
        function safe(url) {
          return fetch(url, { credentials: 'same-origin', cache: 'no-store' })
            .then(bwkJson)
            .then(function (value) { return { value: value } })
            .catch(function (cause) { return { error: String((cause && cause.message) || cause) } })
        }
        return Promise.all([safe(CX_PROJECTS), safe(LEDGER_API)]).then(function (results) {
          if (!alive.current) return
          var codexResult = results[0]
          var ledgerResult = results[1]
          if (codexResult.value) setCodex(codexResult.value)
          if (ledgerResult.value) setLedger(ledgerResult.value)
          var messages = []
          if (codexResult.error) messages.push('Codex 会话读取失败：' + codexResult.error)
          if (ledgerResult.error) messages.push('执行台账读取失败：' + ledgerResult.error)
          setError(messages.join('；'))
          if (bridgeUI.id) return
          var firstThread = null
          var projects = (codexResult.value && codexResult.value.projects) || []
          for (var index = 0; index < projects.length && !firstThread; index += 1) {
            firstThread = (projects[index].threads || [])[0] || null
          }
          var firstExecution = null
          var ledgerProjects = (ledgerResult.value && ledgerResult.value.projects) || []
          for (var index2 = 0; index2 < ledgerProjects.length && !firstExecution; index2 += 1) {
            firstExecution = (ledgerProjects[index2].sessions || [])[0] || null
          }
          if (firstThread) choose('thread', firstThread.id)
          else if (firstExecution) choose('execution', firstExecution.sessionId)
        })
      }, [])
      useEffect(function () {
        alive.current = true
        load()
        var timer = setInterval(load, 20000)
        return function () { alive.current = false; clearInterval(timer) }
      }, [load])
      useEffect(function () {
        if (sel.kind !== 'thread' || !sel.id) { setThread(null); return }
        var current = sel.id
        setThreadBusy(true)
        fetch(CX_THREAD + '?id=' + encodeURIComponent(current), { credentials: 'same-origin', cache: 'no-store' })
          .then(bwkJson)
          .then(function (next) {
            if (!alive.current || bridgeUI.id !== current) return
            setThread(next.thread || null)
          })
          .catch(function (cause) {
            if (!alive.current || bridgeUI.id !== current) return
            setThread(null)
            setError('读取 Codex 会话失败：' + String((cause && cause.message) || cause))
          })
          .then(function () {
            if (alive.current && bridgeUI.id === current) setThreadBusy(false)
          })
      }, [sel.kind, sel.id])

      var term = query.trim().toLowerCase()
      var groupsByCwd = {}
      var codexProjects = (codex && codex.projects) || []
      var ledgerProjects = (ledger && ledger.projects) || []
      function groupFor(cwd) {
        var key = cwd || '(none)'
        if (!groupsByCwd[key]) groupsByCwd[key] = { cwd: cwd || '', name: cwd ? basename(cwd) : '未记录目录', threads: [], sessions: [] }
        return groupsByCwd[key]
      }
      codexProjects.forEach(function (project) {
        var group = groupFor(project.cwd)
        if (project.cwd && (!group.name || group.name === '（未指定工作目录）')) group.name = project.name || group.name
        ;(project.threads || []).forEach(function (item) { group.threads.push(item) })
      })
      ledgerProjects.forEach(function (project) {
        var group = groupFor(project.cwd)
        ;(project.sessions || []).forEach(function (item) { group.sessions.push(item) })
      })
      var allGroups = Object.keys(groupsByCwd).map(function (key) { return groupsByCwd[key] })
        .map(function (group) {
          return Object.assign({}, group, {
            visibleThreads: group.threads.filter(function (item) {
              return term === '' || (String(item.name || '') + ' ' + String(group.name)).toLowerCase().indexOf(term) >= 0
            }),
            visibleSessions: group.sessions.filter(function (item) {
              return term === '' || (String(item.task || '') + ' ' + String(item.sessionId || '') + ' ' + String(group.name)).toLowerCase().indexOf(term) >= 0
            }),
          })
        })
        .filter(function (group) { return group.visibleThreads.length || group.visibleSessions.length })
        .sort(function (a, b) {
          return Math.max.apply(null, [0].concat(a.visibleThreads.map(function (t) { return t.updatedAt || 0 }), a.visibleSessions.map(function (s) { return s.startedAt || 0 })))
            - Math.max.apply(null, [0].concat(b.visibleThreads.map(function (t) { return t.updatedAt || 0 }), b.visibleSessions.map(function (s) { return s.startedAt || 0 })))
        })
      // Selection details are independent of navigation filtering; search must
      // never turn a selected thread into an empty-cwd match for unrelated runs.
      var allExecutions = ledgerProjects.reduce(function (all, project) { return all.concat(project.sessions || []) }, [])
      var selectedExecution = sel.kind === 'execution' ? allExecutions.filter(function (item) { return item.sessionId === sel.id })[0] || null : null
      var selectedThreadInfo = null
      var selectedProject = null
      allGroups.forEach(function (group) {
        var found = group.threads.filter(function (item) { return item.id === sel.id })[0]
        if (found && sel.kind === 'thread') { selectedThreadInfo = found; selectedProject = group }
        if (sel.kind === 'execution' && group.sessions.some(function (item) { return item.sessionId === sel.id })) selectedProject = group
      })
      // Default scope hides Codex-only scratch projects (`new-chat`, `hi`, ...)
      // that have no bridge execution; the selected project always stays visible.
      var linkedProjects = allGroups.filter(function (group) { return group.sessions.length > 0 }).length
      var groups = allGroups.filter(function (group) {
        return bridgeUI.scope === 'all' || group.sessions.length > 0 || group === selectedProject
      })
      if (!selectedProject && sel.kind === 'thread') {
        codexProjects.forEach(function (project) {
          var found = (project.threads || []).filter(function (item) { return item.id === sel.id })[0]
          if (found) { selectedThreadInfo = found; selectedProject = project }
        })
      }
      var selectedGroupCwd = selectedProject ? selectedProject.cwd : ''
      var threadDetail = thread && sel.kind === 'thread' && thread.id === sel.id ? thread : null
      var relatedExecutions = selectedGroupCwd ? allExecutions.filter(function (item) { return item.cwd && item.cwd === selectedGroupCwd }) : []

      var tree = h('aside', { className: 'bwk-nav', 'aria-label': '项目与会话' },
        h('div', { className: 'bwk-nav-head' },
          h('span', { className: 'bwk-brandmark' }, 'C'),
          h('strong', null, 'Codex × DSH'),
          h('small', null, '只读')),
        h('div', { className: 'bwk-search' },
          bwkIcon('search'),
          h('input', { 'aria-label': '搜索项目、会话或任务', placeholder: '搜索项目、会话或任务', value: query, onChange: function (event) {
            bridgeUI.query = event.target.value
            setQuery(event.target.value)
          } })),
        h('div', { className: 'bwk-scope', role: 'group', 'aria-label': '项目范围' },
          h('button', { type: 'button', className: scope === 'linked' ? 'active' : '', 'aria-pressed': scope === 'linked', onClick: function () {
            bridgeUI.scope = 'linked'
            setScope('linked')
          } }, '有执行', h('small', null, linkedProjects)),
          h('button', { type: 'button', className: scope === 'all' ? 'active' : '', 'aria-pressed': scope === 'all', onClick: function () {
            bridgeUI.scope = 'all'
            setScope('all')
          } }, '全部 Codex', h('small', null, allGroups.length))),
        h('div', { className: 'bwk-tree' },
          groups.map(function (group) {
            var key = group.cwd || group.name
            var holdsSelection = group.threads.some(function (item) { return sel.kind === 'thread' && item.id === sel.id })
              || group.sessions.some(function (item) { return sel.kind === 'execution' && item.sessionId === sel.id })
            // Projects with dozens of Codex threads would drown the tree; keep
            // them collapsed unless they hold the current selection.
            var isCollapsed = collapsed[key] !== undefined ? collapsed[key] : !holdsSelection
            var showAllThreads = Boolean(expandedProjects[key]) || term !== ''
            var shownThreads = showAllThreads ? group.visibleThreads : group.visibleThreads.slice(0, 10)
            var hiddenThreads = group.visibleThreads.length - shownThreads.length
            return h('section', { className: 'bwk-project', key: key },
              h('button', { type: 'button', className: 'bwk-proj', 'aria-expanded': !isCollapsed, onClick: function () {
                var next = Object.assign({}, collapsed)
                next[key] = !isCollapsed
                setCollapsed(next)
              } },
                h('span', { className: 'bwk-icon', 'aria-hidden': 'true' },
                  h('svg', { viewBox: '0 0 16 16', style: { transform: isCollapsed ? 'none' : 'rotate(90deg)' } }, h('path', { d: 'M6 4l4 4-4 4' }))),
                bwkIcon('folder'),
                h('span', { className: 'bwk-proj-name', title: group.cwd || group.name }, group.name),
                h('span', { className: 'bwk-count' }, (group.visibleThreads.length + group.visibleSessions.length))),
              isCollapsed ? null : h('div', { className: 'bwk-children' },
                shownThreads.map(function (item) {
                  return h('button', {
                    type: 'button',
                    key: 't-' + item.id,
                    className: 'bwk-row' + (sel.kind === 'thread' && sel.id === item.id ? ' selected' : ''),
                    title: item.name || '',
                    onClick: function () { choose('thread', item.id) },
                  },
                    h('span', { className: 'bwk-dot thread' }),
                    h('span', { className: 'bwk-row-main' },
                      h('span', { className: 'bwk-row-name' }, item.name || '（未命名会话）'),
                      h('span', { className: 'bwk-row-meta' }, 'Codex · ' + fmtWhen(item.updatedAt || item.createdAt))))
                }),
                group.visibleSessions.map(function (item) {
                  var status = bwkStatus(item)
                  var execution = item.execution
                  return h('button', {
                    type: 'button',
                    key: 's-' + item.sessionId,
                    className: 'bwk-row' + (sel.kind === 'execution' && sel.id === item.sessionId ? ' selected' : ''),
                    title: item.task || '',
                    onClick: function () { choose('execution', item.sessionId) },
                  },
                    h('span', { className: 'bwk-dot ' + status.key }),
                    h('span', { className: 'bwk-row-main' },
                      h('span', { className: 'bwk-row-name' }, bwkTaskOf(item)),
                      h('span', { className: 'bwk-row-meta' },
                        'DSH · ' + status.label + ' · ' + fmtWhen(item.startedAt),
                        execution ? h('span', null, ' · ' + execution.model) : null)))
                }),
                hiddenThreads > 0 ? h('button', { type: 'button', className: 'bwk-more', onClick: function () {
                  var next = Object.assign({}, expandedProjects)
                  next[key] = true
                  setExpandedProjects(next)
                } }, '展开其余 ' + hiddenThreads + ' 个 Codex 会话')
                  : null))
          }),
          groups.length === 0 ? h('div', { className: 'bwk-empty' }, h('b', null, '没有匹配的项目'), h('span', null, term ? '换个搜索词试试。' : scope === 'linked' ? '还没有 DSH 执行记录；切到“全部 Codex”查看所有项目。' : '连接正常后，这里会显示 Codex 项目与 DSH 执行。')) : null))

      var tabs = null
      var body = null
      if (sel.kind === 'thread') {
        var threadName = (selectedThreadInfo && selectedThreadInfo.name) || (threadDetail && threadDetail.name) || 'Codex 会话'
        var threadCwd = (selectedThreadInfo && selectedThreadInfo.cwd) || (threadDetail && threadDetail.cwd) || selectedGroupCwd
        var threadModel = (selectedThreadInfo && selectedThreadInfo.model) || (threadDetail && threadDetail.model) || ''
        tabs = h('div', { className: 'bwk-tabs' },
          h('button', { type: 'button', className: 'bwk-tab' + (tab === 'conversation' ? ' active' : ''), onClick: function () { bridgeUI.tab = 'conversation'; setTab('conversation') } }, '对话'),
          h('button', { type: 'button', className: 'bwk-tab' + (tab === 'executions' ? ' active' : ''), onClick: function () { bridgeUI.tab = 'executions'; setTab('executions') } }, '关联执行 ' + relatedExecutions.length))
        if (tab === 'conversation') {
          var turns = (threadDetail && threadDetail.turns) || []
          body = threadBusy && turns.length === 0
            ? h('div', { className: 'bwk-empty' }, h('b', null, '正在读取 Codex 会话…'))
            : h(React.Fragment, null,
              h('div', { className: 'bwk-msgs' }, turns.length ? turns.map(function (turn, index) {
                var isUser = turn.role === 'user'
                var cleaned = cleanCodexText(turn.text || '')
                return h('div', { className: 'bwk-msg' + (isUser ? ' user' : ''), key: 'turn-' + index },
                  h('span', { className: 'bwk-avatar' }, isUser ? '你' : 'C'),
                  h('div', { className: 'bwk-msg-body' },
                    h('div', { className: 'bwk-msg-role' }, h('span', null, isUser ? '你' : 'Codex')),
                    h('div', { className: 'bwk-msg-text' }, cleaned.text || '（这条消息没有可读文本）'),
                    cleaned.images ? h('div', { className: 'bwk-attach' }, bwkIcon('image'), '含 ' + cleaned.images + ' 张图片（在 Codex App 查看）') : null))
              }) : h('div', { className: 'bwk-empty' }, h('b', null, threadBusy ? '正在读取…' : '这个会话没有可读的文本记录'), h('span', null, '完整工具过程请在 Codex App 查看。'))),
              h('div', { className: 'bwk-note' },
                h('strong', { style: { color: 'var(--dsw-alias-label-primary)' } }, '在 Codex App 继续下达任务'),
                h('div', null, '这里只读显示 Codex 的决策与回复，不接管 Codex 会话，也不向已有会话发送消息。')))
        } else {
          body = h(React.Fragment, null,
            h('div', { className: 'bwk-msgs' }, relatedExecutions.length ? relatedExecutions.map(function (item) {
              var status = bwkStatus(item)
              var execution = item.execution
              return h('div', { className: 'bwk-card', key: item.sessionId },
                h('div', { className: 'bwk-eyebrow' }, h('span', { className: 'bwk-status ' + status.key }, status.label), h('span', null, fmtWhen(item.startedAt))),
                h('h3', { style: { margin: '8px 0 6px', fontSize: '13px' } }, bwkTaskOf(item)),
                execution ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '8px' } }, execution.provider + '/' + execution.model + ' · ' + (execution.reasoningEffort || '模型默认')) : null,
                h('div', { style: { display: 'flex', gap: '8px' } },
                  h('button', { type: 'button', className: 'bwk-btn', onClick: function () { choose('execution', item.sessionId) } }, '查看执行详情'),
                  h('button', { type: 'button', className: 'bwk-btn ghost', onClick: function () { openNative(item) } }, '打开 DSH 原生会话')))
            }) : h('div', { className: 'bwk-empty' }, h('b', null, '这个目录下没有 DSH 执行记录'), h('span', null, '台账只记录 Codex 经执行桥发起、且目录一致的会话；未记录父会话 ID，不做自动猜配。'))))
        }
        body = h(React.Fragment, null,
          h('div', { className: 'bwk-eyebrow' }, 'CODEX APP · 只读同步'),
          h('h1', { className: 'bwk-title' }, threadName),
          h('div', { className: 'bwk-context' }, h('span', null, threadCwd || '未记录工作目录'), threadModel ? h('span', { className: 'bwk-tag' }, threadModel) : null),
          tabs, body)
      } else if (selectedExecution) {
        var status2 = bwkStatus(selectedExecution)
        var execution2 = selectedExecution.execution
        tabs = h('div', { className: 'bwk-tabs' },
          h('button', { type: 'button', className: 'bwk-tab' + (tab === 'result' || tab === 'conversation' ? ' active' : ''), onClick: function () { bridgeUI.tab = 'result'; setTab('result') } }, '结果'),
          h('button', { type: 'button', className: 'bwk-tab' + (tab === 'process' ? ' active' : ''), onClick: function () { bridgeUI.tab = 'process'; setTab('process') } }, '过程'))
        var steps = [
          { key: 'delegate', title: '接收 Codex 委派', at: selectedExecution.startedAt, done: true, text: 'DSH 子会话已创建；台账未记录 Codex 父会话 ID，不自动猜配。' },
          selectedExecution.endedAt
            ? { key: 'end', title: '执行结束', at: selectedExecution.endedAt, done: true, text: status2.label + (selectedExecution.elapsedMs ? ' · 用时 ' + fmtDuration(selectedExecution.elapsedMs) : '') }
            : { key: 'running', title: status2.label, at: 0, active: true, text: selectedExecution.question ? '问题已转给 Codex；等待 dsh_answer 后继续同一轮。' : '尚无终止记录；可打开 DSH 原生会话查看实时执行。' },
          { key: 'report', title: '结果回传', at: selectedExecution.endedAt || 0, done: Boolean(selectedExecution.endedAt), text: selectedExecution.error ? selectedExecution.error : (selectedExecution.text ? String(selectedExecution.text).slice(0, 200) : '没有最终回答记录。') },
        ]
        if (tab === 'process') {
          body = h(React.Fragment, null,
            h('ul', { className: 'bwk-steps' }, steps.map(function (step) {
              return h('li', { className: 'bwk-step' + (step.done ? ' done' : '') + (step.active ? ' active' : ''), key: step.key },
                h('span', { className: 'bwk-step-dot' }),
                h('div', { className: 'bwk-step-title' }, step.title, h('small', null, step.at ? absTime(step.at) : '')),
                h('p', null, step.text))
            })),
            h('div', { className: 'bwk-note' }, '这里只给出台账可确认的关键节点。工具调用、命令输出、审批与完整轨迹请打开 DSH 原生会话查看。'))
        } else {
          body = h(React.Fragment, null,
            selectedExecution.question ? h('div', { className: 'bwk-card', role: 'status' },
              h('h3', null, '等待 Codex 回答'),
              h('p', null, '问题已转发给 Codex，请在 Codex 回答后由 dsh_answer 继续本次执行；不要重新提交任务。'),
              (selectedExecution.question.questions || []).map(function (q) {
                return h('div', { key: q.id, style: { marginTop: '10px' } }, h('strong', null, q.question),
                  h('p', null, (q.options || []).map(function (o) { return o.label }).join(' / ')))
              })) : null,
            execution2 ? h('div', { className: 'bwk-card' },
              h('h3', null, '本次执行使用的模型'),
              h('div', { style: { fontSize: '12px' } }, execution2.provider + '/' + execution2.model + ' · 强度 ' + (execution2.reasoningEffort || '（模型默认）') + ' · ' + bwkEffortSource(execution2.effortSource)),
              h('div', { style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)', marginTop: '4px' } }, '政策 revision ' + (execution2.policyRevision || 0) + (execution2.reason ? ' · 原因：' + execution2.reason : ''))) : null,
            h('div', { className: 'bwk-card' },
              h('h3', null, '当时的结果摘要'),
              h('p', { className: 'bwk-result' }, selectedExecution.text || '没有最终回答记录。')),
            selectedExecution.error ? h('div', { className: 'bwk-err', role: 'alert' }, selectedExecution.error) : null,
            h('div', { className: 'bwk-note' },
              '完整消息、工具参数与输出、轨迹和审批都在 DSH 原生会话中查看；本工作台不复制或伪造执行记录。',
              h('div', { style: { marginTop: '10px' } },
                h('button', { type: 'button', className: 'bwk-btn primary', onClick: function () { openNative(selectedExecution) } }, '打开 DSH 原生会话'))))
        }
        body = h(React.Fragment, null,
          h('div', { className: 'bwk-eyebrow' }, 'DSH 执行子会话', h('span', { className: 'bwk-status ' + status2.key }, status2.label)),
          h('h1', { className: 'bwk-title' }, bwkTaskOf(selectedExecution)),
          h('div', { className: 'bwk-context' }, h('span', null, selectedExecution.cwd || '未记录工作目录'), h('span', { className: 'bwk-tag' }, 'session ' + selectedExecution.sessionId.slice(0, 8) + '…')),
          tabs, body)
      } else {
        body = h('div', { className: 'bwk-empty' }, h('b', null, '选择左侧项目或会话'), h('span', null, 'Codex 会话只读显示；DSH 执行记录可查看结果并打开官方原生会话。'))
      }

      var inspectorBody = null
      if (sel.kind === 'thread' && (selectedThreadInfo || threadDetail)) {
        var info = selectedThreadInfo || threadDetail
        var related = relatedExecutions
        inspectorBody = h(React.Fragment, null,
          h('h2', null, info.name || '（未命名会话）'),
          h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '10px' } },
            h('span', { className: 'bwk-status run' }, '只读同步'),
            h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, '同目录 DSH 执行 ' + related.length + ' 条')),
          h('p', { className: 'bwk-desc' }, 'Codex App 正在负责这个会话；这里只读取它的决策与回复，不接管、不重发。'),
          h('dl', { className: 'bwk-dl' },
            h('dt', null, '工作目录'), h('dd', null, info.cwd || threadCwd || '未记录'),
            h('dt', null, '模型'), h('dd', null, info.model || threadModel || '未记录'),
            h('dt', null, '最近更新'), h('dd', null, info.updatedAt ? absTime(info.updatedAt) : '未记录')),
          h('hr', { className: 'bwk-rule' }),
          h('div', { className: 'bwk-section-title' }, '同目录的 DSH 执行'),
          related.length
            ? h('div', { className: 'bwk-related' }, related.map(function (item) { return bwkMiniRow(item, function (record) { choose('execution', record.sessionId) }) }))
            : h('p', { className: 'bwk-desc', style: { margin: 0 } }, '暂无。台账只记录 Codex 经执行桥发起、且目录一致的会话。'),
          h('div', { className: 'bwk-note', style: { marginBottom: 0 } }, '台账没有 Codex 父会话 ID，因此这里只按工作目录列出执行，不声称是父子关系。'))
      } else if (selectedExecution) {
        var status3 = bwkStatus(selectedExecution)
        var execution3 = selectedExecution.execution
        inspectorBody = h(React.Fragment, null,
          h('h2', null, bwkTaskOf(selectedExecution)),
          h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '10px' } },
            h('span', { className: 'bwk-status ' + status3.key }, status3.label),
            h('span', { className: 'bwk-tag' }, 'DSH 台账')),
          h('p', { className: 'bwk-desc' }, selectedExecution.task || '未记录任务描述'),
          h('dl', { className: 'bwk-dl' },
            h('dt', null, '会话 ID'), h('dd', null, selectedExecution.sessionId),
            h('dt', null, '工作目录'), h('dd', null, selectedExecution.cwd || '未记录'),
            h('dt', null, '开始时间'), h('dd', null, absTime(selectedExecution.startedAt)),
            h('dt', null, '执行耗时'), h('dd', null, fmtDuration(selectedExecution.elapsedMs)),
            h('dt', null, '执行模型'), h('dd', null, execution3 ? execution3.provider + '/' + execution3.model : '未记录（旧会话）'),
            h('dt', null, '推理强度'), h('dd', null, execution3 ? (execution3.reasoningEffort || '模型默认') + ' · ' + bwkEffortSource(execution3.effortSource) : '未记录'),
            h('dt', null, '工作区'), h('dd', null, selectedExecution.workspaceId ? '已挂载到 DSH 工作区' : '未挂载（游离会话，仅在桥接记录中）'),
            h('dt', null, 'Codex 关联'), h('dd', null, '未记录父会话 ID · 不自动猜配')),
          h('div', { style: { margin: '16px 0' } },
            h('button', { type: 'button', className: 'bwk-btn primary', style: { width: '100%' }, onClick: function () { openNative(selectedExecution) } }, '打开 DSH 原生会话')),
          h('hr', { className: 'bwk-rule' }),
          h('div', { className: 'bwk-section-title' }, '执行过程'),
          h('ul', { className: 'bwk-steps' }, [
            { key: 'd', title: '接收 Codex 委派', at: selectedExecution.startedAt, done: true, text: '目录与预设已确定，创建 DSH 子会话。' },
            selectedExecution.endedAt
              ? { key: 'e', title: '执行结束', at: selectedExecution.endedAt, done: true, text: status3.label + ' · ' + fmtDuration(selectedExecution.elapsedMs) }
              : { key: 'r', title: status3.label, active: true, text: selectedExecution.question ? '等待 Codex 使用 dsh_answer 回答。' : '尚无终止记录。' },
            { key: 'f', title: '结果回传', at: selectedExecution.endedAt || 0, done: Boolean(selectedExecution.endedAt), text: '结果已记录在台账，可在左侧“结果”查看。' },
          ].map(function (step) {
            return h('li', { className: 'bwk-step' + (step.done ? ' done' : '') + (step.active ? ' active' : ''), key: step.key },
              h('span', { className: 'bwk-step-dot' }),
              h('div', { className: 'bwk-step-title' }, step.title, h('small', null, step.at ? fmtWhen(step.at) : '')),
              h('p', null, step.text))
          })),
          h('div', { className: 'bwk-note', style: { marginBottom: 0 } }, '台账最多 200 条、每目录 60 条，不代表完整历史；完整过程以原生会话为准。'))
      }

      var inspectorNode = h('aside', { className: 'bwk-inspector' + (inspector ? ' open' : ''), 'aria-label': '详情' },
        h('div', { className: 'bwk-inspector-head' },
          h('span', null, sel.kind === 'thread' ? '会话详情' : '执行详情'),
          h('span', { className: 'bwk-tag', style: { marginLeft: 'auto' } }, sel.kind === 'thread' ? '只读' : '台账'),
          h('button', { type: 'button', className: 'bwk-btn ghost', 'aria-label': '关闭详情', onClick: function () { bridgeUI.inspector = false; setInspector(false) } }, '×')),
        h('div', { className: 'bwk-inspector-body' }, inspectorBody))

      var top = h('div', { className: 'bwk-top' },
        h('div', { className: 'bwk-crumb' },
          bwkIcon('folder'),
          h('span', null, (selectedProject && selectedProject.name) || '工作台'),
          h('span', { style: { opacity: .5 } }, '/'),
          h('b', null, sel.kind === 'thread' ? ((selectedThreadInfo && selectedThreadInfo.name) || 'Codex 会话') : (selectedExecution ? bwkTaskOf(selectedExecution) : '请选择会话'))),
        h('div', { className: 'bwk-actions' },
          h('button', {type:'button',className:'bwk-btn small',onClick:function(){setTasksVisible(true)}},'任务'),
          error ? h('span', { className: 'bwk-status err' }, '有错误') : null,
          h('button', { type: 'button', className: 'bwk-btn small', 'aria-pressed': inspector, title: inspector ? '收起右侧详情' : '打开右侧详情', onClick: function () { bridgeUI.inspector = !inspector; setInspector(!inspector) } },
            bwkIcon('panel'), inspector ? '收起' : '详情'),
          h('button', { type: 'button', className: 'bwk-btn small', disabled: threadBusy, title: '刷新数据', onClick: function () { load() } }, bwkIcon('refresh'), threadBusy ? '刷新中' : '刷新'),
          h('button', { type: 'button', className: 'bwk-btn small', title: '执行模型与思考强度', onClick: function () { bridgeUI.settings = true; setSettings(true) } }, bwkIcon('settings'), '执行模型')))

      if(tasksVisible) return h(TaskWorkbench,{onBack:function(){setTasksVisible(false)}})
      return h('div', { className: 'bwk' + (inspector ? '' : ' no-inspector') },
        tree,
        h('main', { className: 'bwk-main' },
          top,
          h('div', { className: 'bwk-scroll' },
            (error || navError) ? h('div', { className: 'bwk-err', role: 'alert', style: { margin: '16px 34px 0' } }, error || navError) : null,
            h('div', { className: 'bwk-content' }, body))),
        inspectorNode,
        settings ? h('div', { className: 'bwk-overlay', role: 'dialog', 'aria-label': '执行模型设置' },
          h('div', { className: 'bwk-modal' },
            h('div', { className: 'bwk-modal-head' }, '执行模型与思考强度',
              h('button', { type: 'button', className: 'bwk-btn ghost', style: { marginLeft: 'auto' }, onClick: function () { bridgeUI.settings = false; setSettings(false) } }, '关闭')),
            h('div', { className: 'bwk-modal-body' }, h(ModelPolicySettings)))) : null)
    }

    function Page() {
      var dataState = useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var errorState = useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var loadingState = useState(true)
      var loading = loadingState[0]
      var setLoading = loadingState[1]
      var expandedState = useState('')
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]
      var kindState = useState('decide')
      var kind = kindState[0]
      var setKind = kindState[1]
      var promptState = useState('')
      var prompt = promptState[0]
      var setPrompt = promptState[1]
      var askingState = useState(false)
      var asking = askingState[0]
      var setAsking = askingState[1]
      var resultState = useState(null)
      var result = resultState[0]
      var setResult = resultState[1]
      var askErrorState = useState('')
      var askError = askErrorState[0]
      var setAskError = askErrorState[1]
      var pageRef = React.useRef(null)
    var resettingState = useState(false)
      var resetting = resettingState[0]
      var setResetting = resettingState[1]

      var load = useCallback(function () {
        setLoading(true)
        jget()
          .then(function (next) {
            setData(next)
            setError('')
          })
          .catch(function (cause) {
            setError(String((cause && cause.message) || cause))
          })
          .then(function () {
            setLoading(false)
          })
      }, [])

      useEffect(
        function () {
          load()
        },
        [load],
      )

      // Always open at the top (Chromium restores scroll on reload otherwise).
      useEffect(function () {
        if (pageRef.current) pageRef.current.scrollTop = 0
      }, [])

      var ask = useCallback(
        function () {
          if (asking || prompt.trim() === '') return
          setAsking(true)
          setAskError('')
          setResult(null)
          jpost({ action: 'consult', kind: kind, prompt: prompt.trim() })
            .then(function (next) {
              setResult(next)
              load()
            })
            .catch(function (cause) {
              setAskError(String((cause && cause.message) || cause))
            })
            .then(function () {
              setAsking(false)
            })
        },
        [asking, kind, prompt, load],
      )

      var reset = useCallback(
        function () {
          if (resetting) return
          setResetting(true)
          setAskError('')
          jpost({ action: 'reset' })
            .then(function () {
              setResult(null)
              load()
            })
            .catch(function (cause) {
              setAskError(String((cause && cause.message) || cause))
            })
            .then(function () {
              setResetting(false)
            })
        },
        [resetting, load],
      )

      var codex = (data && data.codex) || {}
      var reverse = (data && data.reverse) || {}
      var app = (data && data.appPlugin) || {}
      var runs = (data && data.runs) || []
      var sessions = codex.sessions || []
      var pageSession = codex.pageSession || null

      var header = h(
        'header',
        { className: 'cb-head' },
        h(
          'div',
          { className: 'cb-head-main' },
          h('span', { className: 'cb-mark' }, h(Mark, { size: 19 })),
          h(
            'div',
            { style: { minWidth: 0 } },
            h('div', { className: 'cb-title-row' }, h('h1', { className: 'cb-title' }, 'Codex 桥'), data && data.version ? h('span', { className: 'cb-version' }, 'v' + data.version) : null),
            h('p', { className: 'cb-sub' }, 'GPT 当参谋、DSH 当执行手。这里只读桥的状态与最近咨询，也可以单独问 GPT 一句——不占用也不打断左侧会话。'),
          ),
        ),
        h(
          'div',
          { className: 'cb-head-side' },
          data ? h('span', { className: 'cb-head-meta' }, 'Codex ' + (codex.version || '—') + ' · pid ' + (reverse.pid || '—')) : null,
          h('button', { className: 'cb-btn', type: 'button', onClick: load, disabled: loading, title: '重新读取状态' }, loading ? h('span', { className: 'cb-spin' }) : null, loading ? '刷新中' : '刷新'),
        ),
      )

      var codexCard = h(
        StatusCard,
        { title: 'GPT 参谋 · 方向 A', chip: data ? codex.sessionMode : '', chipCls: 'cb-chip-brand', loading: !data },
        h(
          'div',
          { className: 'cb-rows' },
          h(Row, { label: '活跃会话' }, String(sessions.length) + ' / ' + String(codex.maxSessions || '—'), sessions.length ? null : h('span', { className: 'cb-muted' }, '  · 空闲')),
          h(Row, { label: '工作目录', mono: true }, sessions.length ? basename(sessions[0].cwd) + (sessions.length > 1 ? ' +' + (sessions.length - 1) : '') : '—'),
          h(Row, { label: '模型' }, codex.model || 'native'),
          h(Row, { label: '推理强度' }, codex.effort || 'native'),
          h(Row, { label: '沙箱' }, codex.sandbox || '—'),
          h(Row, { label: 'Codex', mono: true }, (codex.version || '未知版本') + (codex.binSource ? ' · ' + codex.binSource : '')),
        ),
      )

      var reverseCard = h(
        StatusCard,
        { title: '反向桥 · 方向 B', chip: 'Codex → DSH', loading: !data },
        h(
          'div',
          { className: 'cb-rows' },
          h(Row, { label: '路由' }, reverse.enabled ? h(Chip, { cls: 'cb-chip-ok' }, '已注册') : h(Chip, { cls: 'cb-chip-err' }, '未启用')),
          h(Row, { label: '端点', mono: true }, h('span', { className: 'cb-code', style: { display: 'inline-block' } }, 'POST ' + (reverse.executePath || '—'))),
          h(Row, { label: 'Bearer token' }, reverse.tokenReady ? h(Chip, { cls: 'cb-chip-ok' }, '已就绪') : h(Chip, { cls: 'cb-chip-warn' }, '缺失')),
          h(Row, { label: 'DSH 进程', mono: true }, 'pid ' + (reverse.pid || '—')),
        ),
        h('div', { className: 'cb-card-note' }, '外部（Codex / MCP）走 Bearer token；页面自身走浏览器同源鉴权，两套互不暴露。'),
      )

      var appCard = h(
        StatusCard,
        { title: 'Codex App 插件', chip: 'dsh-bridge@personal', loading: !data },
        h(
          'div',
          { className: 'cb-rows' },
          h(
            Row,
            { label: '状态' },
            app.installed && app.configEntry ? h(Chip, { cls: 'cb-chip-ok' }, 'installed, enabled') : app.marketplace ? h(Chip, { cls: 'cb-chip-warn' }, '已上架，未安装') : h(Chip, { cls: 'cb-chip-err' }, '未安装'),
          ),
          h(Row, { label: '版本' }, app.version || '—'),
          h(Row, { label: 'MCP 工具' }, h(CodeLines, { items: app.tools || ['—'] })),
        ),
        h('div', { className: 'cb-card-note' }, app.installed && app.configEntry ? 'App 里若看不到工具：完全退出 Codex App 再打开（插件在启动时加载）。' : '按 docs/codex-app-plugin.md 安装后，重启 Codex App 生效。'),
      )

      var runsSection = h(
        'section',
        { className: 'cb-section' },
        h(
          'div',
          { className: 'cb-section-head' },
          h('h2', { className: 'cb-section-title' }, '最近咨询'),
          h('span', { className: 'cb-section-count' }, runs.length ? '最近 ' + runs.length + ' 条' : ''),
          h('span', { className: 'cb-section-hint' }, '来自 ~/.dsh/codex-bridge/runs · 点一行展开'),
        ),
        h(
          'div',
          { className: 'cb-table' },
          runs.length
            ? [
                h(
                  'div',
                  { className: 'cb-thead', key: 'head' },
                  h('span', null, '时间'),
                  h('span', null, '类型'),
                  h('span', null, '模式'),
                  h('span', null, '耗时 · tokens'),
                ),
              ].concat(
                runs.map(function (run) {
                  var km = KIND_META[run.kind] || { label: run.kind, dot: '' }
                  var mode = MODE_META[run.mode] || { label: run.mode || 'exec', cls: '' }
                  var open = expanded === run.file
                  return h(
                    React.Fragment,
                    { key: run.file },
                    h(
                      'div',
                      {
                        className: 'cb-run',
                        onClick: function () { setExpanded(open ? '' : run.file) },
                        role: 'button',
                        tabIndex: 0,
                        'aria-expanded': open,
                        title: absTime(run.at),
                      },
                      h('span', { className: 'cb-run-time' }, fmtWhen(run.at)),
                      h('span', { className: 'cb-run-kind' }, h('span', { className: 'cb-dot ' + km.dot }), km.label),
                      h('span', { className: 'cb-run-mode' }, h('span', { className: 'cb-mode ' + mode.cls }, mode.label)),
                      h(
                        'span',
                        { className: 'cb-run-meta' },
                        h('b', null, fmtDuration(run.elapsedMs)),
                        ' · ' + fmtTokens(run.inputTokens) + ' in / ' + fmtTokens(run.outputTokens) + ' out',
                      ),
                    ),
                    open
                      ? h(
                          'div',
                          { className: 'cb-detail' },
                          h(Kv, { label: '工作目录' }, run.cwd || '—'),
                          run.threadId ? h(Kv, { label: 'thread' }, run.threadId) : null,
                          run.fallbackReason ? h(Kv, { label: '回退原因' }, run.fallbackReason) : null,
                          h(Kv, { label: '记录文件' }, run.file),
                          run.preview ? h('pre', { className: 'cb-pre' }, run.preview) : null,
                        )
                      : null,
                  )
                }),
              )
            : h('div', { className: 'cb-empty' }, h('b', null, '还没有咨询记录'), h('span', null, '在会话里调一次 codex_decide，或在下面快速问一句。')),
        ),
      )

      var pageThread = pageSession && pageSession.threadId ? pageSession.threadId : ''
      var formCard = h(
        'div',
        { className: 'cb-form-card' },
        h(
          'div',
          { className: 'cb-form-head' },
          h('h2', { className: 'cb-section-title', style: { margin: 0 } }, '快速咨询'),
          pageThread
            ? h(Chip, { cls: pageSession && pageSession.busy ? 'cb-chip-warn' : 'cb-chip-ok' }, '页面会话 · ' + (pageSession && pageSession.busy ? '思考中' : '就绪'))
            : h(Chip, null, '页面会话 · 未建立'),
          h('span', { className: 'cb-form-note' }, '不进入左侧会话、不打断对话；连续提问会记得前文。'),
        ),
        h(
          'div',
          { className: 'cb-form-row' },
          h(
            'select',
            { className: 'cb-select', value: kind, onChange: function (event) { setKind(event.target.value) }, 'aria-label': '咨询类型' },
            h('option', { value: 'decide' }, 'codex_decide · 要一个裁决'),
            h('option', { value: 'plan' }, 'codex_plan · 要一个计划'),
            h('option', { value: 'ask' }, 'codex_ask · 问一句'),
          ),
          h('span', { className: 'cb-form-note' }, '一次约 5–40 秒'),
          h('span', { className: 'cb-form-grow' }),
          pageThread ? h('span', { className: 'cb-kbd', title: '页面会话 thread id' }, pageThread.slice(0, 18) + '…') : null,
          h('button', { className: 'cb-btn cb-btn-ghost', type: 'button', onClick: reset, disabled: resetting || asking, title: '丢弃页面会话，下次重新建立（会清空上下文）' }, resetting ? '重建中…' : '重建会话'),
        ),
        h('textarea', {
          className: 'cb-textarea',
          value: prompt,
          placeholder: kind === 'plan' ? '要达成的目标，一句话；可加验收标准与约束（Ctrl+Enter 提交）' : '要 Codex 定夺的问题，一句话；可加关键事实（Ctrl+Enter 提交）',
          onChange: function (event) { setPrompt(event.target.value) },
          onKeyDown: function (event) {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              ask()
            }
          },
          maxLength: 20_000,
        }),
        h(
          'div',
          { className: 'cb-form-row' },
          h('button', { className: 'cb-btn cb-btn-primary', type: 'button', onClick: ask, disabled: asking || prompt.trim() === '', style: { minWidth: 110 } }, asking ? h('span', { className: 'cb-spin' }) : null, asking ? '等待 Codex…' : '问 Codex'),
          h('span', { className: 'cb-form-note' }, 'Ctrl+Enter 提交'),
          h('span', { className: 'cb-form-grow' }),
          h('span', { className: 'cb-count' }, String(prompt.length) + ' / 20000'),
        ),
      )

      return h(
        'div',
        { className: 'cb-page', ref: pageRef },
        h(
          'div',
          { className: 'cb-inner' },
          header,
          error ? h('div', { className: 'cb-error' }, '读取桥状态失败：' + error) : null,
          h('div', { className: 'cb-grid' }, codexCard, reverseCard, appCard),
          runsSection,
          formCard,
          askError ? h('div', { className: 'cb-error' }, askError) : null,
          result ? h(ConsultResult, { kind: result.kind, value: result.value, meta: result.meta }) : null,
          h('div', { className: 'cb-foot' }, (data && data.version ? 'dsh-codex-bridge v' + data.version : 'dsh-codex-bridge') + ' · 本页不显示 Bearer token；token 仅在 ~/.dsh/codex-bridge/http-token，供 Codex 的 MCP 服务端读取。'),
        ),
      )
    }

    return {
      inject: ['slots', 'uiWorkspace', 'sessions'],
      apply: function apply(ctx) {
        var style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-codex-bridge')
        style.textContent = CSS
        document.head.appendChild(style)
        var workbenchStyle = document.createElement('style')
        workbenchStyle.setAttribute('data-plugin-css', 'dsh-codex-bridge-workbench')
        workbenchStyle.textContent = BRIDGE_CSS
        document.head.appendChild(workbenchStyle)
        if (typeof ctx.effect === 'function') ctx.effect(function () {
          return function () {
            style.remove()
            workbenchStyle.remove()
          }
        })

        var slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        var uiWorkspace = (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined) || ctx.uiWorkspace
        var sessions = (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined) || ctx.sessions
        nativeOpen = async function (sessionId, isCurrent) {
          if (isCurrent && !isCurrent()) return
          if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('缺少有效的 DSH 会话 ID')
          if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') throw new Error('当前版本没有原生会话导航服务')
          if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') throw new Error('当前版本没有原生会话目录服务')
          function known() {
            var snapshot = sessions.list.getSnapshot()
            return Boolean(snapshot && snapshot.byId && snapshot.byId[sessionId]) || Boolean(typeof sessions.subagentAddress === 'function' && sessions.subagentAddress(sessionId))
          }
          if (!known()) {
            if (typeof sessions.refresh !== 'function') throw new Error('原生会话目录无法刷新，请刷新 DSH 窗口后重试')
            await sessions.refresh()
            if (isCurrent && !isCurrent()) return
            if (!known()) throw new Error('该执行记录尚未进入 DSH 原生会话目录，或已不可恢复。请刷新后重试；不会新建或重跑任务。')
          }
          return uiWorkspace.openSession(sessionId)
        }
        if (typeof ctx.effect === 'function') ctx.effect(function () { return function () { nativeOpen = null } })

        // One public entry only. The legacy dashboard is intentionally no
        // longer registered in either sidebar.panellist or main.
        slots.inject('sidebar.panellist', function () {
          return slots.register({ name: 'sidebar.panellist', id: 'codex', order: 15, label: 'Codex' }, function (props) {
            return h(Mark, { size: (props && props.size) || 20 })
          })
        })
        slots.inject('main', function () {
          return slots.register({ name: 'main', key: 'codex' }, function () {
            return h(BridgeWorkbench)
          })
        })
      },
    }
  },
})
