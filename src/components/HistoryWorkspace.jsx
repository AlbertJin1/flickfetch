import React, { useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, FileClock, FolderOpen, RotateCcw, Search, Trash2 } from 'lucide-react';
import { formatBytes, safeHost, timeAgo } from '../lib/format.js';
import { SectionHeading, StatusPill } from './Primitives.jsx';

export default function HistoryWorkspace({ items, onRetry, onRemove, onOpenPath, onSelectItem }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const history = useMemo(() => items.filter(item => ['Done', 'Failed', 'Canceled'].includes(item.status)).filter(item => {
    if (status !== 'all' && item.status.toLowerCase() !== status) return false;
    return !search || `${item.title} ${item.url}`.toLowerCase().includes(search.toLowerCase());
  }), [items, search, status]);

  return (
    <div className="scrollbar-thin h-full overflow-y-auto px-7 pb-8 pt-6">
      <SectionHeading eyebrow="Library" title="Download history" description="Review completed, failed, and canceled tasks from this device." right={<div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[10px] font-semibold text-slate-500"><FileClock size={13} /> Recent activity</div>} />
      <div className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4"><div><div className="text-[13px] font-bold text-slate-900">Past downloads</div><div className="mt-0.5 text-[9px] text-slate-400">History is saved locally on this computer.</div></div><div className="relative w-[220px]"><Search size={12} className="absolute left-2.5 top-2.5 text-slate-400" /><input className="w-full rounded-lg border border-slate-200 py-1.5 pl-8 pr-2 text-[10px] outline-none focus:border-brand-400" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search downloads…" /></div></div>
        <div className="flex items-center gap-1 border-b border-slate-100 bg-slate-50/60 px-4 py-2">{[['all', 'All'], ['done', 'Completed'], ['failed', 'Failed'], ['canceled', 'Canceled']].map(([key, label]) => <button key={key} onClick={() => setStatus(key)} className={`rounded-lg px-3 py-1.5 text-[9px] font-bold ${status === key ? 'bg-white text-brand-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-400 hover:text-slate-700'}`}>{label}</button>)}</div>
        {history.length ? <div className="divide-y divide-slate-100">{history.map(item => <div key={item.id} className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50/60"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${item.status === 'Done' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-500'}`}>{item.status === 'Done' ? <CheckCircle2 size={17} /> : <FileClock size={17} />}</div><button onClick={() => onSelectItem(item.id)} className="min-w-0 flex-1 text-left"><div className="truncate text-[11px] font-bold text-slate-800">{item.title || item.url}</div><div className="mt-1 truncate text-[9px] text-slate-400">{safeHost(item.url)} · {timeAgo(item.createdAt)}{item.filePath ? ` · ${formatBytes(item.finalSize)}` : ''}</div>{item.errorText && <div className="mt-0.5 truncate text-[9px] text-rose-500">{item.errorText}</div>}</button><StatusPill status={item.status} />{item.status === 'Done' && item.filePath && <button title="Reveal in folder" className="btn-quiet" onClick={() => onOpenPath(item.filePath)}><FolderOpen size={14} /></button>}{['Failed', 'Canceled'].includes(item.status) && <button className="btn-quiet" onClick={() => onRetry(item.id)}><RotateCcw size={14} /> Retry</button>}<button className="btn-quiet hover:!text-rose-600" onClick={() => onRemove(item.id)}><Trash2 size={14} /></button></div>)}</div> : <div className="px-6 py-16 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"><FileClock size={20} /></div><div className="mt-3 text-[13px] font-bold text-slate-800">No history found</div><div className="mt-1 text-[10px] text-slate-400">Completed and failed downloads will appear here.</div></div>}
      </div>
    </div>
  );
}
