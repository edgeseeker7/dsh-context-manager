/* dsh-context-manager (client half).
 *
 * Makes `/reset' checkpoints inspectable in the web chat. The stock chat UI
 * only renders an expandable compaction row for the command literally named
 * "compact" (its commandDefinition gates on `command.name === "compact"`),
 * and its automatic-compaction Definition ignores every event carrying a
 * sourceCommandId — so a `/reset' lands as a plain one-line command outcome
 * while the full injected checkpoint sits unreachable in the session log.
 *
 * The official extension seams let us fix this without touching the host:
 * event projection is multi-claim (every Definition whose match() returns
 * non-null receives the event), and chat rows render through the
 * `conversation.chat.node' slot registry keyed by node kind. So this bundle
 *
 *   1. registers a conversation Definition that claims the `/reset' command
 *      lifecycle (command/run + its correlated compaction/* events and the
 *      replacement checkpoint user/message, all keyed by commandId) and
 *      builds a view node of our own kind carrying the full checkpoint text;
 *   2. registers a slot renderer for that node kind: a disclosure row in
 *      the style of the stock CompactionItem — one summary line, click to
 *      expand the verbatim injected content (MarkdownText).
 *
 * The stock command row stays: official /compact shows the same two-row
 * pattern (command outcome + compaction detail). All colors come from the
 * host's --dsw-* theme variables.
 *
 * Hand-written in the __ModuleLoader__ factory format (no build step); React
 * is required from the host-provided module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-manager',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    // Host markdown primitive for the checkpoint body; absent → plain-text fallback.
    let MarkdownText = null;
    try {
      MarkdownText = require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText ?? null;
    } catch {
      MarkdownText = null;
    }

    const NS = 'context-manager';
    /** Chat renderer dispatch key for our checkpoint node. */
    const NODE_KIND = 'context-manager-reset';
    /**
     * source.plugin marker the compaction engine stamps on checkpoint
     * user/message events (same constant the stock UI matches against).
     */
    const COMPACT_PLUGIN = 'compact';
    /** Runtime mirror of the host's surface-event union. */
    const SURFACE_EVENT_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result']);

    const zh = {
      'reset.title': '上下文已重置',
      'reset.completed': '已重置 {items} 条历史记录（约 {tokens} tokens）',
      'reset.expand': '点击查看注入内容',
      'reset.unavailable': '注入内容不可用',
      'reset.body': '本次 reset 注入的完整内容',
      'md.copy': '复制',
      'md.copied': '已复制',
      'md.footnotes': '脚注',
    };
    const en = {
      'reset.title': 'Context window reset',
      'reset.completed': 'Reset {items} history items (~{tokens} tokens)',
      'reset.expand': 'Click to view the injected content',
      'reset.unavailable': 'Injected content unavailable',
      'reset.body': 'Full content injected by this reset',
      'md.copy': 'Copy',
      'md.copied': 'Copied',
      'md.footnotes': 'Footnotes',
    };

    const CSS = `
.dshcm-reset-row{margin:2px 0}
.dshcm-reset-button{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;background:none;border:none;padding:4px 8px;margin:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);border-radius:6px;text-align:left;cursor:pointer}
.dshcm-reset-button:hover:not(:disabled){background:var(--dsw-alias-fill-l1,rgba(127,127,127,.08))}
.dshcm-reset-button:disabled{cursor:default}
.dshcm-reset-chevron{flex:none;width:12px;text-align:center;color:var(--dsw-alias-label-caption)}
.dshcm-reset-title{flex:none;color:var(--dsw-alias-label-secondary);font-weight:500}
.dshcm-reset-sep{flex:none;color:var(--dsw-alias-label-caption)}
.dshcm-reset-sep::before{content:"·"}
.dshcm-reset-summary{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption)}
.dshcm-reset-body{margin:4px 8px 8px 26px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;max-height:420px;overflow:auto;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.6}
.dshcm-reset-fallback{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:inherit}
`;
    const CSS_TAG_ID = 'dsh-context-manager/reset-checkpoint.module.css';
    const ensureStyles = () => {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-context-manager';
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    };

    /** Narrow an event to a surface-eligible event (mirrors the host guard). */
    const isSurfaceEvent = (event) => SURFACE_EVENT_TYPES.has(event.type) && event.surfaceOp !== undefined;
    /** Narrow to a replacement-origin surface event (the landed checkpoint). */
    const isReplacementSurfaceEvent = (event) => isSurfaceEvent(event) && event.surfaceOp !== 'append';
    /**
     * Read compaction correlation identity from a checkpoint user/message
     * (mirrors the stock compactSource): the compaction engine stamps
     * source.kind 'plugin', plugin 'compact', a compactionId, and — for
     * command-triggered compactions — the sourceCommandId.
     */
    const compactSource = (event) => {
      if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event)) return undefined;
      const source = event.data?.source;
      if (source?.kind !== 'plugin' || source.plugin !== COMPACT_PLUGIN || typeof source.compactionId !== 'string') {
        return undefined;
      }
      return {
        compactionId: source.compactionId,
        ...(source.sourceCommandId === undefined ? {} : { sourceCommandId: source.sourceCommandId }),
      };
    };

    /** Fold one claimed event into the Definition state. */
    const foldEvent = (state, event) => {
      if (event.type === 'command/run') return { ...state, run: event };
      if (event.type === 'compaction/summary') return { ...state, summary: event };
      if (compactSource(event) !== undefined) return { ...state, checkpoint: event };
      return state;
    };
    /** Rebuild state from raw matches when the engine kept none. */
    const foldMatches = (matches) => matches.reduce((state, match) => foldEvent(state, match.event), {});

    /**
     * The `/reset' lifecycle Definition. Claims only command/run events named
     * "reset" as start; the correlated compaction lifecycle and the landed
     * checkpoint join as updates keyed by the same commandId. `/compact'
     * lifetimes never get a start (their command/run is not claimed), so
     * buildViewNode returns null for them and the stock UI keeps owning the
     * official row — no duplication.
     */
    const resetCheckpointDefinition = {
      kind: NODE_KIND,
      target: 'chat',
      match: (event) => {
        if (event.type === 'command/run') {
          if (event.data?.name !== 'reset') return null;
          return { id: String(event.data.commandId), role: 'start' };
        }
        if (
          event.type === 'compaction/start' ||
          event.type === 'compaction/summary' ||
          event.type === 'compaction/end'
        ) {
          const commandId = event.data?.sourceCommandId;
          if (typeof commandId === 'string' && commandId !== '') {
            return { id: commandId, role: 'update' };
          }
          return null;
        }
        const source = compactSource(event);
        if (source?.sourceCommandId !== undefined) {
          return { id: String(source.sourceCommandId), role: 'update' };
        }
        return null;
      },
      start: (_context, match) => foldEvent({}, match.event),
      update: (context, match) => foldEvent(context.state, match.event),
      buildViewNode: (context) => {
        const state = context.state ?? foldMatches(context.matches);
        if (state.run === undefined || state.run.data?.name !== 'reset') return null;
        // Mirror the stock compaction Definition: no row before the
        // checkpoint lands; the plain command row carries progress already.
        if (state.checkpoint === undefined) return null;
        let summary = null;
        let shadowedItemCount = null;
        let shadowedTokenCount = null;
        const data = state.summary?.data;
        if (data !== undefined) {
          if (Array.isArray(data.summary)) {
            const text = data.summary.map((block) => (block?.type === 'text' ? block.text : '')).join('');
            summary = text.trim() === '' ? null : text;
          }
          shadowedItemCount =
            Array.isArray(data.shadowedSeqs) && data.shadowedSeqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0)
              ? data.shadowedSeqs.length
              : null;
          shadowedTokenCount =
            Number.isSafeInteger(data.shadowedTokenCount) && data.shadowedTokenCount >= 0
              ? data.shadowedTokenCount
              : null;
        }
        return {
          key: context.key,
          kind: NODE_KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: state.checkpoint.seq,
          location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
          visibility: 'visible',
          data: {
            seq: state.checkpoint.seq,
            time: state.checkpoint.time,
            summary,
            shadowedItemCount,
            shadowedTokenCount,
          },
        };
      },
    };

    /** Plain-text stand-in when the host markdown primitive is unavailable. */
    function FallbackText({ text }) {
      return React.createElement('p', { className: 'dshcm-reset-fallback' }, text);
    }

    /**
     * Disclosure row for one landed `/reset' checkpoint: title + one-line
     * stat summary; click expands the verbatim injected content.
     */
    function ResetCheckpointItem({ data, t }) {
      const [expanded, setExpanded] = React.useState(false);
      const expandable = data.summary !== null;
      const open = expandable && expanded;
      const line =
        data.shadowedItemCount !== null && data.shadowedTokenCount !== null
          ? t('reset.completed', { items: data.shadowedItemCount, tokens: data.shadowedTokenCount })
          : expandable
            ? t('reset.expand')
            : t('reset.unavailable');
      return React.createElement(
        'div',
        { className: 'dshcm-reset-row' },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dshcm-reset-button',
            disabled: !expandable,
            'aria-expanded': expandable ? open : undefined,
            onClick: () => setExpanded((value) => !value),
          },
          React.createElement('span', { className: 'dshcm-reset-chevron', 'aria-hidden': true }, open ? '▾' : '▸'),
          React.createElement('span', { className: 'dshcm-reset-title' }, t('reset.title')),
          React.createElement('span', { className: 'dshcm-reset-sep', 'aria-hidden': true }),
          React.createElement('span', { className: 'dshcm-reset-summary' }, line),
        ),
        open && data.summary !== null
          ? React.createElement(
              'div',
              { className: 'dshcm-reset-body', 'aria-label': t('reset.body') },
              React.createElement(
                MarkdownText !== null ? MarkdownText : FallbackText,
                MarkdownText !== null
                  ? {
                      text: data.summary,
                      labels: {
                        code: { copyLabel: t('md.copy'), copiedLabel: t('md.copied') },
                        footnotes: t('md.footnotes'),
                      },
                    }
                  : { text: data.summary },
              ),
            )
          : null,
      );
    }

    const ResetCheckpointNodeView = React.memo(function ResetCheckpointNodeView({ node, t }) {
      return React.createElement(ResetCheckpointItem, { data: node.data, t });
    });

    // cordis service-access guard: declare every service apply() touches.
    const inject = ['slots', 'locale', 'uiConversation'];

    function apply(ctx) {
      ensureStyles();
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'context-manager: dictionaries');
      // Lifetime is bound to this context inside the registry itself.
      ctx.uiConversation.events.register(resetCheckpointDefinition);
      ctx.slots.inject('conversation.chat.node', () =>
        ctx.slots.register({ name: 'conversation.chat.node', key: NODE_KIND, locale: NS }, ResetCheckpointNodeView),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
