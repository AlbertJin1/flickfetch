import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

/** Pill-style segmented control (radio group semantics). */
export function Segmented({ value, onChange, options, label, size = 'md' }) {
  return (
    <div className={`ff-seg ff-seg-${size}`} role="radiogroup" aria-label={label}>
      {options.map(option => {
        const Icon = option.icon;
        const active = String(option.value) === String(value);
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={active ? 'is-active' : ''}
            onClick={() => onChange(option.value)}
          >
            {Icon && <Icon size={15} aria-hidden="true" />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Filter tabs with live counts. Tabs with a zero count can be hidden via `hideEmpty`. */
export function FilterTabs({ value, onChange, tabs, label }) {
  return (
    <div className="ff-tabs" role="tablist" aria-label={label}>
      {tabs.map(tab => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          className={value === tab.value ? 'is-active' : ''}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
          {typeof tab.count === 'number' && <span className="ff-tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A labelled on/off switch used for inline options. */
export function SwitchChip({ checked, onChange, label, hint, disabled = false }) {
  const id = useId();
  return (
    <label className={`ff-switch ${disabled ? 'is-disabled' : ''}`} htmlFor={id} title={hint}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span className="ff-switch-track" aria-hidden="true"><span /></span>
      <span className="ff-switch-label">{label}</span>
    </label>
  );
}

/** Small anchored menu for secondary actions ("More"). Closes on outside click and Escape. */
export function ActionMenu({ label, icon: Icon, items, align = 'right' }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = event => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  return (
    <div className="ff-menu" ref={rootRef}>
      <button type="button" className="ff-btn ff-btn-ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {Icon && <Icon size={15} aria-hidden="true" />}{label}<ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className={`ff-menu-list ff-menu-${align}`} role="menu">
          {items.map(item => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={item.danger ? 'is-danger' : ''}
              onClick={() => { setOpen(false); item.onSelect(); }}
            >
              {item.icon && <item.icon size={15} aria-hidden="true" />}
              <span>{item.label}{item.hint && <small>{item.hint}</small>}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Horizontal progress through a multi-step flow. */
export function Stepper({ steps, current }) {
  return (
    <ol className="ff-stepper" aria-label="Progress">
      {steps.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'todo';
        return (
          <li key={step.label} className={`ff-step is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="ff-step-dot">{state === 'done' ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : index + 1}</span>
            <span className="ff-step-copy"><strong>{step.label}</strong><small>{step.hint}</small></span>
          </li>
        );
      })}
    </ol>
  );
}

/** Slim progress bar. */
export function Meter({ value, indeterminate = false, tone = 'brand' }) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className={`ff-meter ff-meter-${tone}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : Math.round(safe)}>
      <span className={indeterminate ? 'is-indeterminate' : ''} style={indeterminate ? undefined : { width: `${safe}%` }} />
    </div>
  );
}
