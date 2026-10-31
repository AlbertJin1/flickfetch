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

  useEffect(() => {
    dialogRef.current?.querySelector('.review-stars button')?.focus();
  }, []);

  useEffect(() => {
    const handleKey = event => { if (event.key === 'Escape' && !sending) dismissRef.current('later'); };
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
      <section ref={dialogRef} className="review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title">
        <header className="review-head">
          <div className="review-icon"><MessageSquareText size={19} /></div>
          <div><h2 id="review-title">Review FlickFetch</h2><p>Your feedback helps improve the app.</p></div>
          <button type="button" className="icon-button" onClick={() => dismiss('later')} disabled={sending} aria-label="Close review"><X size={17} /></button>
        </header>
        <form onSubmit={submit}>
          <fieldset className="review-rating">
            <legend>How would you rate your experience?</legend>
            <div className="review-stars" onMouseLeave={() => setHovered(0)}>
              {[1, 2, 3, 4, 5].map(value => (
                <button key={value} type="button" className={(hovered || rating) >= value ? 'is-active' : ''}
                  aria-label={`${value} star${value === 1 ? '' : 's'}`} aria-pressed={rating === value}
                  onMouseEnter={() => setHovered(value)} onFocus={() => setHovered(value)} onBlur={() => setHovered(0)} onClick={() => setRating(value)}>
                  <Star size={29} fill="currentColor" />
                </button>
              ))}
            </div>
            <span className="review-rating-hint">{['Select a rating', 'Needs improvement', 'Fair', 'Good', 'Very good', 'Excellent'][hovered || rating]}</span>
          </fieldset>
          <label className="review-field"><span>Name <small>optional</small></span><input value={name} onChange={event => setName(event.target.value)} maxLength={60} placeholder="Your name" autoComplete="name" /></label>
          <label className="review-field"><span>Your feedback <small>optional</small></span><textarea value={message} onChange={event => setMessage(event.target.value)} maxLength={1500} rows={4} placeholder="What works well? What could be better?" /></label>
          {error && <p className="review-error" role="alert">{error}</p>}
          <footer className="review-actions"><button type="button" className="btn-secondary" onClick={() => dismiss('later')} disabled={sending}>{auto ? 'Remind me later' : 'Cancel'}</button><button type="submit" className="btn-primary" disabled={sending || !rating}>{sending ? 'Sending…' : <><Send size={14} /> Submit review</>}</button></footer>
        </form>
        {auto && <button type="button" className="review-never-button" onClick={() => dismiss('never')} disabled={sending}>Don’t ask me again</button>}
      </section>
    </div>
  );
}
