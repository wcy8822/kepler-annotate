(function (root, factory) {
  'use strict';
  const suggestion = typeof module === 'object' && module.exports
    ? require('./review-suggestion.js') : root.KPReviewSuggestion;
  const api = factory(suggestion);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KPReviewProvider = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (suggestion) {
  'use strict';
  const FIELDS = ['text', 'observed', 'expected', 'reproduction'];
  const OUTPUT = ['schemaVersion', 'origin', 'readOnly', 'proposal', 'needsConfirmation'];
  function failure(code, message) {
    const error = Error(message);
    error.code = code;
    return error;
  }
  function limitedInput(annotation) {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation))
      throw failure('KP_REVIEW_PROVIDER_INPUT', '批注来源无效');
    const input = {};
    for (const field of FIELDS) {
      const value = annotation[field] ?? '';
      if (typeof value !== 'string' || value.length > 4000)
        throw failure('KP_REVIEW_PROVIDER_INPUT', '批注文本类型或长度无效');
      input[field] = value;
    }
    if (!input.text.trim()) throw failure('KP_REVIEW_PROVIDER_INPUT', '请先保存原话');
    return Object.freeze(input); // No URL, DOM, images, file paths, credentials or tools.
  }
  function validateOutput(output, origin) {
    if (!output || typeof output !== 'object' || Array.isArray(output) ||
        Object.keys(output).length !== OUTPUT.length ||
        !OUTPUT.every(key => Object.hasOwn(output, key)) ||
        output.schemaVersion !== 1 || output.origin !== origin || output.readOnly !== true ||
        typeof output.proposal !== 'string' || !output.proposal.trim() ||
        output.proposal.length > 3000 || typeof output.needsConfirmation !== 'boolean')
      throw failure('KP_REVIEW_PROVIDER_RESPONSE', '只读建议响应不符合契约');
    return Object.freeze({schemaVersion:1, origin, readOnly:true,
      proposal:output.proposal, needsConfirmation:output.needsConfirmation});
  }
  // An adapter is an explicit in-extension callback, not an HTTP/Native client.
  // External providers must not be registered until their separate send consent exists.
  function createAdapter(id, invoke) {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(id) || typeof invoke !== 'function')
      throw failure('KP_REVIEW_PROVIDER_CONFIG', '建议适配器配置无效');
    async function request({annotation, sourceHash, signal, timeoutMs = 15000} = {}) {
      if (typeof sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(sourceHash))
        throw failure('KP_REVIEW_PROVIDER_INPUT', '来源摘要无效');
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
        throw failure('KP_REVIEW_PROVIDER_INPUT', '建议超时参数无效');
      const input = limitedInput(annotation);
      if (signal?.aborted) throw failure('KP_REVIEW_PROVIDER_CANCELLED', '建议请求已取消');
      if (signal !== undefined && (typeof signal?.addEventListener !== 'function' ||
          typeof signal?.removeEventListener !== 'function'))
        throw failure('KP_REVIEW_PROVIDER_INPUT', '取消信号无效');
      const controller = new AbortController();
      let timer;
      let timedOut = false;
      const abort = () => controller.abort();
      if (signal) signal.addEventListener('abort', abort, {once:true});
      const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () =>
        reject(failure(timedOut ? 'KP_REVIEW_PROVIDER_TIMEOUT' : 'KP_REVIEW_PROVIDER_CANCELLED',
          timedOut ? '建议请求超时，原始批注未改变' : '建议请求已取消，原始批注未改变')),
      {once:true}));
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        // A late/duplicate reply cannot win after cancellation or timeout.
        const output = await Promise.race([
          Promise.resolve().then(() => invoke(input, {signal:controller.signal})), cancelled
        ]);
        if (controller.signal.aborted || signal?.aborted)
          throw failure('KP_REVIEW_PROVIDER_CANCELLED', '建议请求已取消');
        return Object.freeze({...validateOutput(output, id), sourceHash});
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abort);
      }
    }
    return Object.freeze({id, request});
  }
  // Test-only Native transport. It is never registered as a production provider.
  // Only synthetic identifiers and an H1 digest cross this boundary, never input text.
  function createNativeFixtureAdapter(send, {enabled = false, pollMs = 100} = {}) {
    if (enabled !== true || typeof send !== 'function' ||
        !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1000)
      throw failure('KP_REVIEW_PROVIDER_CONFIG', '合成 Native 建议适配器默认关闭');
    const invalid = () => failure('KP_REVIEW_PROVIDER_RESPONSE', '合成 Native 建议响应无效');
    const cancelled = () => failure('KP_REVIEW_PROVIDER_CANCELLED', '建议请求已取消');
    async function request({annotation, sourceHash, signal, timeoutMs} = {}) {
      const requestId = globalThis.crypto.randomUUID();
      const adapter = createAdapter('native-fixture', async (_, {signal}) => {
        let submitted = false, terminal = false, cancellationSent = false;
        const cancel = () => {
          if (!submitted || terminal || cancellationSent) return;
          cancellationSent = true;
          // Best effort only. A lost host response is not proof of cancellation.
          Promise.resolve().then(() => send({op:'review-preview-cancel',requestId})).catch(() => {});
        };
        const checkAbort = () => { if (signal.aborted) throw cancelled(); };
        const checkEnvelope = reply => {
          if (!reply || reply.ok !== true || reply.synthetic !== true ||
              reply.requestId !== requestId) throw invalid();
        };
        signal.addEventListener('abort', cancel, {once:true});
        try {
          checkAbort();
          const info = await send({op:'info'});
          checkAbort();
          if (info?.ok !== true || info.capabilities?.reviewPreviewLifecycle !== 'synthetic_fixture_only')
            throw failure('KP_REVIEW_PROVIDER_CONFIG', 'Native 主机未启用隔离合成测试');
          let ack;
          // Wait for the submit response before cancelling, even if timeout
          // occurs while submit is in flight. An early cancel could miss the job.
          try {
            ack = await send({op:'review-preview-request',requestId,
              provider:'synthetic-fixture',synthetic:true,sourceHash});
          } finally { submitted = true; }
          checkAbort();
          checkEnvelope(ack);
          if (ack.provider !== 'synthetic-fixture' || ack.duplicate !== false || ack.state !== 'queued')
            throw invalid();
          for (;;) {
            checkAbort();
            const status = await send({op:'review-preview-status',requestId});
            checkAbort();
            checkEnvelope(status);
            if (status.state === 'cancelled') {
              terminal = true;
              throw cancelled();
            }
            if (status.state === 'completed') {
              if (!status.candidate || status.candidate.sourceHash !== sourceHash) throw invalid();
              const {sourceHash: ignored, ...candidate} = status.candidate;
              const checked = validateOutput(candidate, 'native-fixture');
              if (checked.needsConfirmation !== true) throw invalid();
              terminal = true;
              return checked;
            }
            if (status.state !== 'queued' || Object.hasOwn(status,'candidate')) throw invalid();
            await new Promise(resolve => setTimeout(resolve,pollMs));
          }
        } finally {
          signal.removeEventListener('abort',cancel);
          cancel();
        }
      });
      return adapter.request({annotation,sourceHash,signal,timeoutMs});
    }
    return Object.freeze({id:'native-fixture',request});
  }
  const local = createAdapter('local-template', annotation => suggestion.fromSavedAnnotation(annotation));
  return Object.freeze({createAdapter, createNativeFixtureAdapter, requestLocal: local.request});
});
