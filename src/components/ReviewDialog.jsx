import React, { useEffect, useRef, useState } from 'react';
import { MessageSquareText, Send, Star, X } from 'lucide-react';

export default function ReviewDialog({ onClose, onSubmitted, auto = false }) {
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef(null);

  // An automatically shown prompt remembers the choice (snooze 7 days / never ask again); a manual review does not.
  const dismiss = async (choice = 'later') => {
    if (sending) return;
    if (auto) {
      try { await window.flickfetch.monitor.deferReview?.(choice); }
      catch (deferError) { console.warn('Could not save the review preference:', deferError?.message || deferError); }
    }
    onClose?.();
  };

  // Keep the latest dismiss handler in a ref so the effects below can run once, on mount only.
  // (Re-running on every render re-focused the close button each time the person typed.)
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  // Focus the dialog itself, not a star: focusing the first star used to light it up as if the pointer were on it.
  useEffect(() => { dialogRef.current?.focus({ preventScroll: true }); }, []);

  // Radio-group keyboard behaviour: arrows move and select, Home/End jump, Tab leaves the group.
  const onStarKey = event => {
    const keys = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    let next = 0;
    if (event.key in keys) next = Math.min(5, Math.max(1, (rating || (keys[event.key] > 0 ? 0 : 6)) + keys[event.key]));
    else if (event.key === 'Home') next = 1;
    else if (event.key === 'End') next = 5;
    else if (/^[1-5]$/.test(event.key)) next = Number(event.key);
    if (!next) return;
    event.preventDefault(); setRating(next); setError('');
    event.currentTarget.parentElement.querySelectorAll('button')[next - 1]?.focus();
  };

  useEffect(() => {
    const handleKey = event => {
      if (event.key === 'Escape' && !sending) { event.preventDefault(); dismissRef.current('later'); return; }
      if (event.key !== 'Tab') return; // keep Tab inside the dialog
      const items = [...(dialogRef.current?.querySelectorAll('button:not([disabled]), input, textarea, [tabindex="0"]') || [])];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [sending]);

  const submit = async event => {
    event.preventDefault();
    if (!rating) { setError('Choose a star rating before submitting.'); return; }
    setSending(true); setError('');
    try {
      const result = await window.flickfetch.monitor.submitReview({ rating, name, message });
      onSubmitted?.(result);
      onClose?.();
    } catch (submitError) { setError(submitError.message || 'Your review could not be sent. Please try again.'); }
    finally { setSending(false); }
  };

  return (
    <div className="review-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !sending) dismiss('later'); }}>
      <section ref={dialogRef} className="review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title" tabIndex={-1}>
        <header className="review-head">
          <div className="review-icon"><MessageSquareText size={19} /></div>
          <div><h2 id="review-title">Review FlickFetch</h2><p>Your feedback helps improve the app.</p></div>
          <button type="button" className="icon-button" onClick={() => dismiss('later')} disabled={sending} aria-label="Close review"><X size={17} /></button>
        </header>
        <form onSubmit={submit} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit(event); }}>
          <fieldset className="review-rating">
            <legend>How would you rate your experience?</legend>
            <div className="review-stars" role="radiogroup" aria-label="Star rating" onMouseLeave={() => setHovered(0)} onKeyDown={onStarKey}>
              {[1, 2, 3, 4, 5].map(value => (
                <button key={value} type="button" role="radio" className={(hovered || rating) >= value ? 'is-active' : ''}
                  aria-label={`${value} star${value === 1 ? '' : 's'}`} aria-checked={rating === value} tabIndex={(rating || 1) === value ? 0 : -1}
                  onMouseEnter={() => setHovered(value)} onClick={() => { setRating(value); setError(''); }}>
                  <Star size={29} fill="currentColor" />
                </button>
              ))}
            </div>
            <span className="review-rating-hint" aria-live="polite">{['Select a rating', 'Needs improvement', 'Fair', 'Good', 'Very good', 'Excellent'][hovered || rating]}</span>
          </fieldset>
          <label className="review-field"><span>Name <small>optional</small></span><input value={name} onChange={event => setName(event.target.value)} maxLength={60} placeholder="Your name" autoComplete="name" /></label>
          <label className="review-field"><span>Your feedback <small>optional</small></span><textarea value={message} onChange={event => setMessage(event.target.value)} maxLength={1500} rows={4} placeholder="What works well? What could be better?" /><em className="review-count">{message.length} / 1500</em></label>
          {error && <p className="review-error" role="alert">{error}</p>}
          <footer className="review-actions"><button type="button" className="btn-secondary" onClick={() => dismiss('later')} disabled={sending}>{auto ? 'Remind me later' : 'Cancel'}</button><button type="submit" className="btn-primary" disabled={sending || !rating}>{sending ? 'Sending…' : <><Send size={14} /> Submit review</>}</button></footer>
        </form>
        {auto && <button type="button" className="review-never-button" onClick={() => dismiss('never')} disabled={sending}>Don’t ask me again</button>}
      </section>
    </div>
  );
}
