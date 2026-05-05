'use strict';

// Рендерер HTML формы из JSON-схемы.
// Возвращает массив строк-секций, по одной на step. Каждая секция — <section class="step">.

const { escapeHtml } = require('./render');

function attr(name, value) {
  if (value == null || value === false) return '';
  if (value === true) return ` ${name}`;
  return ` ${name}="${escapeHtml(value)}"`;
}

function normalizeOption(opt) {
  if (typeof opt === 'string') return { value: opt, label: opt };
  return { value: opt.value, label: opt.label || opt.value };
}

function renderOption(field, opt, type) {
  const o = normalizeOption(opt);
  const inputName = type === 'checkbox' ? `${field.name}[]` : field.name;
  return `<label class="opt"><input type="${type}" name="${escapeHtml(inputName)}" value="${escapeHtml(o.value)}" /><span>${o.label}</span></label>`;
}

function renderField(field) {
  if (field.kind === 'group') {
    return `
      <div class="field">
        ${field.title ? `<div class="group-title">${escapeHtml(field.title)}</div>` : ''}
        ${(field.fields || []).map(renderField).join('\n')}
      </div>`;
  }

  if (field.kind === 'text' || field.kind === 'email' || field.kind === 'tel') {
    const t = field.type || (field.kind === 'text' ? 'text' : field.kind);
    const id = field.name ? `f-${field.name}` : '';
    return `
      <div class="field">
        ${field.label ? `<label class="label"${id ? ` for="${id}"` : ''}>${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ''}</label>` : ''}
        ${field.hint ? `<p class="hint mb-1">${escapeHtml(field.hint)}</p>` : ''}
        <input class="input" type="${t}"${id ? ` id="${id}"` : ''}${attr('name', field.name)}${attr('placeholder', field.placeholder)}${field.required ? ' required' : ''} />
      </div>`;
  }

  if (field.kind === 'textarea') {
    const id = field.name ? `f-${field.name}` : '';
    return `
      <div class="field">
        ${field.label ? `<label class="label"${id ? ` for="${id}"` : ''}>${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ''}</label>` : ''}
        ${field.hint ? `<p class="hint mb-2">${escapeHtml(field.hint)}</p>` : ''}
        <textarea class="input"${id ? ` id="${id}"` : ''}${attr('name', field.name)}${attr('placeholder', field.placeholder)}${field.required ? ' required' : ''}></textarea>
      </div>`;
  }

  if (field.kind === 'radio' || field.kind === 'checkbox') {
    const grid = field.grid === 3 ? 'cols-3' : (field.grid === 2 ? 'cols-2' : 'cols-1');
    const opts = (field.options || []).map((o) => renderOption(field, o, field.kind)).join('\n          ');
    const extra = field.extra
      ? `<input class="input mt-2" type="text"${attr('name', field.extra.name || `${field.name}_extra`)}${attr('placeholder', field.extra.placeholder)} />`
      : '';
    const otherInput = field.otherText
      ? `<input class="input mt-2" type="text"${attr('name', `${field.name}_other`)}${attr('placeholder', field.otherText)} />`
      : '';
    return `
      <div class="field">
        ${field.label ? `<div class="label">${escapeHtml(field.label)}${field.required ? ' <span class="req">*</span>' : ''}</div>` : ''}
        ${field.hint ? `<p class="hint mb-2">${escapeHtml(field.hint)}</p>` : ''}
        <div class="opt-grid ${grid}">
          ${opts}
        </div>
        ${otherInput}
        ${extra}
      </div>`;
  }

  if (field.kind === 'channels') {
    const items = JSON.stringify(field.items || []);
    return `
      <div class="field" data-channels-host data-channels-name="${escapeHtml(field.name || 'channels')}" data-channels-items='${escapeHtml(items)}'></div>`;
  }

  return `<!-- unknown field kind: ${escapeHtml(field.kind || '?')} -->`;
}

function renderStep(step, index) {
  return `
    <section class="step${index === 0 ? ' active' : ''} card p-6 md:p-8" data-step="${index}" data-step-key="${escapeHtml(step.key)}">
      ${step.label ? `<div class="text-sm font-medium text-accent uppercase tracking-widest mb-2">${escapeHtml(step.label)}</div>` : ''}
      <h2 class="font-display font-extrabold text-2xl md:text-3xl tracking-tight mb-${step.description ? '2' : '6'}">${escapeHtml(step.title)}</h2>
      ${step.description ? `<p class="text-ink-500 mb-6">${escapeHtml(step.description)}</p>` : ''}
      ${(step.fields || []).map(renderField).join('\n')}
    </section>`;
}

function renderThanksStep(schema, index) {
  return `
    <section class="step card p-6 md:p-10 text-center" data-step="${index}" data-step-key="thanks">
      <div class="w-14 h-14 mx-auto rounded-full bg-accent/15 text-accent flex items-center justify-center mb-5">
        <svg class="w-8 h-8" viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <h2 class="font-display font-extrabold text-3xl tracking-tight mb-3">Спасибо!</h2>
      <p class="text-ink-500 leading-relaxed max-w-md mx-auto">
        ${escapeHtml(schema.thanks || 'Изучу ответы и в течение 1 рабочего дня свяжусь с вами.')}
      </p>
      <p class="text-ink-300 text-sm mt-6">Можно закрыть вкладку.</p>
    </section>`;
}

function renderForm(schema) {
  const steps = schema.steps.map(renderStep);
  steps.push(renderThanksStep(schema, schema.steps.length));
  return steps.join('\n');
}

module.exports = { renderForm };
