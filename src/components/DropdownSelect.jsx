import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

/**
 * Consistent, keyboard-accessible select control. The menu is portaled to the
 * document body so it is never clipped by scrollable settings/dialog panels.
 */
export default function DropdownSelect({
  value,
  onChange,
  options = [],
  disabled = false,
  className = '',
  placeholder = 'Select an option',
  ariaLabel,
}) {
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const optionRefs = useRef([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState(null);

  const selectedIndex = useMemo(
    () => options.findIndex(option => String(option.value) === String(value)),
    [options, value]
  );
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const edge = 8;
    const gap = 7;
    const below = window.innerHeight - rect.bottom - edge - gap;
    const above = rect.top - edge - gap;
    const placeAbove = below < Math.min(280, Math.max(150, above)) && above > below;
    const available = Math.max(120, Math.min(320, placeAbove ? above : below));
    const top = placeAbove
      ? Math.max(edge, rect.top - available - gap)
      : Math.min(window.innerHeight - available - edge, rect.bottom + gap);
    const width = Math.min(Math.max(rect.width, 180), window.innerWidth - edge * 2);
    const left = Math.min(Math.max(edge, rect.left), window.innerWidth - width - edge);
    setPosition({ top, left, width, maxHeight: available });
  }, []);

  const close = useCallback(() => setOpen(false), []);
  const choose = useCallback(index => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange?.(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }, [onChange, options]);

  const openMenu = useCallback(() => {
    if (disabled || !options.length) return;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    updatePosition();
    setOpen(true);
  }, [disabled, options.length, selectedIndex, updatePosition]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    updatePosition();
    const onPointerDown = event => {
      if (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      close();
    };
    const onViewportChange = () => updatePosition();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open, close, updatePosition]);

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex]);

  const handleKeyDown = event => {
    if (disabled) return;
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      openMenu();
      return;
    }
    if (!open) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(index => {
        let next = index;
        for (let count = 0; count < options.length; count += 1) {
          next = (next + 1) % options.length;
          if (!options[next]?.disabled) return next;
        }
        return index;
      });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(index => {
        let next = index;
        for (let count = 0; count < options.length; count += 1) {
          next = (next - 1 + options.length) % options.length;
          if (!options[next]?.disabled) return next;
        }
        return index;
      });
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const range = event.key === 'Home' ? [...options.keys()] : [...options.keys()].reverse();
      const found = range.find(index => !options[index]?.disabled);
      if (found !== undefined) setActiveIndex(found);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      close();
    }
  };

  const menu = open && position ? createPortal(
    <div
      ref={menuRef}
      className="dropdown-menu"
      role="listbox"
      aria-label={ariaLabel || placeholder}
      style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
    >
      {options.map((option, index) => {
        const selected = String(option.value) === String(value);
        return (
          <button
            ref={element => { optionRefs.current[index] = element; }}
            key={`${String(option.value)}-${index}`}
            type="button"
            role="option"
            aria-selected={selected}
            disabled={Boolean(option.disabled)}
            className={`dropdown-option ${selected ? 'is-selected' : ''} ${activeIndex === index ? 'is-active' : ''}`}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => choose(index)}
          >
            <span>{option.label}</span>
            {selected && <Check size={15} aria-hidden="true" />}
          </button>
        );
      })}
    </div>,
    document.body
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`field-control dropdown-trigger ${open ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''} ${className}`}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => open ? close() : openMenu()}
        onKeyDown={handleKeyDown}
      >
        <span className="dropdown-value">{selectedOption?.label ?? placeholder}</span>
        <ChevronDown className={`dropdown-chevron ${open ? 'is-open' : ''}`} size={16} aria-hidden="true" />
      </button>
      {menu}
    </>
  );
}
