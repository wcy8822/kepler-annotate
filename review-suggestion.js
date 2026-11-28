(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KPReviewSuggestion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // This provider is fully local, read-only and deliberately not a model.
  // A later model provider must have separate explicit data/send authorization.
  function sourceText(value, label) {
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > 4000) throw Error(label + '超出文本范围');
    return value; // Never normalize or rewrite the user's original words.
  }
  function fromSavedAnnotation(annotation) {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) throw Error('批注来源无效');
    const raw = sourceText(annotation.text, '原话');
    if (!raw.trim()) throw Error('请先填写并保存原话');
    const observed = sourceText(annotation.observed, '实际表现');
    const expected = sourceText(annotation.expected, '预期结果');
    const reproduction = sourceText(annotation.reproduction, '复现步骤');
    const hasExpected = !!expected.trim();
    const lines = ['用户原话（引用，非 AI 判断）：' + raw];
    if (observed.trim()) lines.push('实际表现（用户填写）：' + observed);
    lines.push(hasExpected ? '修改目标（用户填写）：' + expected :
      '待确认：用户尚未填写具体预期，不能推断修改目标');
    if (reproduction.trim()) lines.push('复现步骤（用户填写）：' + reproduction);
    lines.push(hasExpected ? '验收参考：由用户核对修改结果是否符合上述预期' :
      '验收条件：待用户补充预期后确定');
    const proposal = lines.join('\n');
    if (proposal.length > 3000) throw Error('整理结果超过草稿上限，请手动精简，原始内容未改变');
    return Object.freeze({
      schemaVersion: 1, origin: 'local-template', readOnly: true,
      proposal, needsConfirmation: !hasExpected
    });
  }
  return Object.freeze({fromSavedAnnotation});
});
