import React from 'react';
import DropdownSelect from './DropdownSelect.jsx';
import { AlertCircle, Check, CheckCircle2, Info, X } from 'lucide-react';

export function ProgressBar({ value, className = '', indeterminate = false }) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className={`h-2 overflow-hidden rounded-full bg-slate-100 ${className}`}>
      <div className={`h-full rounded-full bg-gradient-to-r from-brand-500 to-violet-400 transition-all duration-300 ${indeterminate ? 'animate-pulse' : ''}`} style={{ width: indeterminate ? '38%' : `${safe}%` }} />
    </div>
  );
}

export function StatusPill({ status }) {
  const styles = {
    Queued: 'bg-slate-100 text-slate-500', Starting: 'bg-amber-50 text-amber-700',
    Downloading: 'bg-brand-50 text-brand-700', Processing: 'bg-violet-50 text-violet-700',
    Done: 'bg-emerald-50 text-emerald-700', Failed: 'bg-rose-50 text-rose-700', Canceled: 'bg-slate-100 text-slate-500'
  };
  const label = status === 'Starting' ? 'Starting' : status || 'Unknown';
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-bold ${styles[status] || styles.Queued}`}><span className={`h-1.5 w-1.5 rounded-full ${status === 'Done' ? 'bg-emerald-500' : status === 'Failed' ? 'bg-rose-500' : status === 'Downloading' || status === 'Processing' ? 'bg-brand-500' : 'bg-current opacity-50'}`} />{label}</span>;
}

export function SectionHeading({ eyebrow, title, description, right }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        {eyebrow && <div className="mb-1.5 text-[9px] font-extrabold uppercase tracking-[.17em] text-brand-600">{eyebrow}</div>}
        <h2 className="text-[21px] font-bold tracking-tight text-slate-900">{title}</h2>
        {description && <p className="mt-1 text-[11px] text-slate-500">{description}</p>}
      </div>
      {right}
    </div>
  );
}

export function StatCard({ icon: Icon, label, value, sub, tone = 'brand' }) {
  const tones = {
    brand: 'bg-brand-50 text-brand-600', emerald: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600', slate: 'bg-slate-100 text-slate-600'
  };
  return (
    <div className="panel flex items-center gap-3 px-4 py-3.5">
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tones[tone]}`}><Icon size={18} /></div>
      <div className="min-w-0"><div className="text-[10px] font-semibold uppercase tracking-[.1em] text-slate-400">{label}</div><div className="mt-0.5 text-[20px] font-bold leading-none text-slate-900">{value}</div>{sub && <div className="mt-1 text-[9px] text-slate-400">{sub}</div>}</div>
    </div>
  );
}

export function Modal({ title, subtitle, onClose, children, footer, width = 'max-w-3xl' }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/45 p-6 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className={`flex max-h-[88vh] w-full ${width} flex-col overflow-hidden rounded-2xl border border-white/70 bg-white shadow-2xl`}>
        <div className="flex items-start justify-between border-b border-slate-100 px-6 py-5">
          <div><h3 className="text-[17px] font-bold text-slate-900">{title}</h3>{subtitle && <p className="mt-1 text-[11px] text-slate-500">{subtitle}</p>}</div>
          <button className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="border-t border-slate-100 bg-slate-50/80 px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

export function Notice({ tone = 'info', children, onDismiss }) {
  const styles = {
    info: 'border-brand-100 bg-brand-50/70 text-brand-800',
    success: 'border-emerald-100 bg-emerald-50 text-emerald-800',
    warning: 'border-amber-100 bg-amber-50 text-amber-800',
    error: 'border-rose-100 bg-rose-50 text-rose-800'
  };
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'error' ? AlertCircle : Info;
  return <div className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[11px] leading-relaxed ${styles[tone]}`}><Icon size={15} className="mt-0.5 shrink-0" /><div className="min-w-0 flex-1">{children}</div>{onDismiss && <button onClick={onDismiss} className="shrink-0 opacity-50 hover:opacity-100"><X size={14} /></button>}</div>;
}

export function Toast({ toast, onClose }) {
  if (!toast) return null;
  const icon = toast.type === 'error' ? <AlertCircle size={17} /> : toast.type === 'success' ? <Check size={17} /> : <Info size={17} />;
  return <div className="fixed bottom-6 right-6 z-[80] flex max-w-[420px] items-start gap-3 rounded-xl border border-slate-700 bg-ink-900 px-4 py-3.5 text-white shadow-2xl"><div className="mt-0.5 text-brand-200">{icon}</div><div className="min-w-0"><div className="text-[12px] font-bold">{toast.title || 'FlickFetch'}</div><div className="mt-0.5 text-[10px] leading-relaxed text-slate-300">{toast.message}</div></div><button className="ml-2 text-slate-400 hover:text-white" onClick={onClose}><X size={15} /></button></div>;
}

export function Toggle({ checked, onChange, label, description }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl py-2.5">
      <span className="min-w-0"><span className="block text-[12px] font-semibold text-slate-700">{label}</span>{description && <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-400">{description}</span>}</span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-brand-600' : 'bg-slate-300'}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} /></button>
    </label>
  );
}

export function Field({ label, value, onChange, placeholder, type = 'text', hint, ...props }) {
  return <label className="block"><span className="field-label">{label}</span><input className="field-control" type={type} value={value ?? ''} placeholder={placeholder} onChange={event => onChange?.(event.target.value)} {...props} />{hint && <span className="mt-1 block text-[9px] leading-relaxed text-slate-400">{hint}</span>}</label>;
}

export function SelectField({ label, value, onChange, options, hint, disabled = false }) {
  return <div className="block min-w-0"><label className="field-label">{label}</label><DropdownSelect value={value} onChange={onChange} options={options} disabled={disabled} ariaLabel={label} />{hint && <span className="mt-1 block text-[9px] text-slate-400">{hint}</span>}</div>;
}
