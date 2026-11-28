import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronUp } from 'lucide-react';
import { useI18nStore } from '../store/i18nStore';

interface ScrollToTopButtonProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  resetKey?: string | number;
  minScrollTop?: number;
  upThreshold?: number;
  downThreshold?: number;
  idleHideMs?: number;
}

export const ScrollToTopButton: React.FC<ScrollToTopButtonProps> = ({
  containerRef,
  resetKey,
  minScrollTop = 200,
  upThreshold = 20,
  downThreshold = 6,
  idleHideMs = 3000,
}) => {
  const { t } = useI18nStore();
  const [visible, setVisible] = useState(false);

  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const upAccumRef = useRef(0);
  const downAccumRef = useRef(0);
  const isScrollingToTopRef = useRef(false);
  const isHoveredRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);
  const scrollToTopFallbackRef = useRef<number | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHideTimer = useCallback(() => {
    clearHideTimer();
    if (idleHideMs <= 0 || isHoveredRef.current) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      if (!isHoveredRef.current) {
        setVisible(false);
      }
    }, idleHideMs);
  }, [clearHideTimer, idleHideMs]);

  useEffect(() => {
    const el = containerRef.current;
    setVisible(false);
    upAccumRef.current = 0;
    downAccumRef.current = 0;
    isScrollingToTopRef.current = false;
    clearHideTimer();

    if (!el) return;

    const getClampedTop = () => {
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      return Math.max(0, Math.min(el.scrollTop, maxScrollTop));
    };

    lastScrollTopRef.current = getClampedTop();
    lastScrollHeightRef.current = el.scrollHeight;

    const handleScroll = () => {
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const currentTop = Math.max(0, Math.min(el.scrollTop, maxScrollTop));

      // Ignore scrollTop clamp caused by content height shrinking/growing (e.g. deleting a track)
      if (el.scrollHeight !== lastScrollHeightRef.current) {
        lastScrollHeightRef.current = el.scrollHeight;
        lastScrollTopRef.current = currentTop;
        if (currentTop <= minScrollTop) {
          upAccumRef.current = 0;
          downAccumRef.current = 0;
          clearHideTimer();
          setVisible(false);
        }
        return;
      }

      const delta = currentTop - lastScrollTopRef.current;
      lastScrollTopRef.current = currentTop;

      if (isScrollingToTopRef.current) {
        if (currentTop <= 10) {
          isScrollingToTopRef.current = false;
          if (scrollToTopFallbackRef.current !== null) {
            window.clearTimeout(scrollToTopFallbackRef.current);
            scrollToTopFallbackRef.current = null;
          }
          upAccumRef.current = 0;
          downAccumRef.current = 0;
          clearHideTimer();
          setVisible(false);
          return;
        }
        if (delta > 4) {
          // User interrupted smooth scroll to top by scrolling down
          isScrollingToTopRef.current = false;
          if (scrollToTopFallbackRef.current !== null) {
            window.clearTimeout(scrollToTopFallbackRef.current);
            scrollToTopFallbackRef.current = null;
          }
        } else {
          return;
        }
      }

      if (currentTop <= minScrollTop) {
        upAccumRef.current = 0;
        downAccumRef.current = 0;
        clearHideTimer();
        setVisible(false);
        return;
      }

      if (delta > 0) {
        // Scrolling down: hide button
        upAccumRef.current = 0;
        downAccumRef.current += delta;
        if (downAccumRef.current >= downThreshold) {
          clearHideTimer();
          setVisible(false);
        }
      } else if (delta < 0) {
        // Scrolling up: reveal button once upward movement passes threshold
        downAccumRef.current = 0;
        upAccumRef.current += -delta;
        if (upAccumRef.current >= upThreshold) {
          setVisible(true);
          scheduleHideTimer();
        }
      }
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      clearHideTimer();
      if (scrollToTopFallbackRef.current !== null) {
        window.clearTimeout(scrollToTopFallbackRef.current);
        scrollToTopFallbackRef.current = null;
      }
    };
  }, [containerRef, resetKey, minScrollTop, upThreshold, downThreshold, clearHideTimer, scheduleHideTimer]);

  const handleClick = () => {
    clearHideTimer();
    isHoveredRef.current = false;
    isScrollingToTopRef.current = true;
    upAccumRef.current = 0;
    downAccumRef.current = 0;
    setVisible(false);
    if (scrollToTopFallbackRef.current !== null) {
      window.clearTimeout(scrollToTopFallbackRef.current);
    }
    scrollToTopFallbackRef.current = window.setTimeout(() => {
      isScrollingToTopRef.current = false;
      scrollToTopFallbackRef.current = null;
    }, 1500);
    containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (!visible) return null;

  return (
    <button
      onClick={handleClick}
      onMouseEnter={() => {
        isHoveredRef.current = true;
        clearHideTimer();
      }}
      onMouseLeave={() => {
        isHoveredRef.current = false;
        scheduleHideTimer();
      }}
      title={t('Back to top', 'Наверх')}
      aria-label={t('Scroll to top', 'Прокрутить наверх')}
      className="fixed bottom-36 md:bottom-28 right-5 md:right-8 z-40 p-3.5 rounded-full bg-cat-mauve text-cat-base shadow-2xl hover:scale-110 active:scale-95 transition-all duration-200 cursor-pointer flex items-center justify-center border-2 border-cat-base animate-in fade-in zoom-in-75"
    >
      <ChevronUp className="w-5 h-5 stroke-[2.5]" />
    </button>
  );
};
