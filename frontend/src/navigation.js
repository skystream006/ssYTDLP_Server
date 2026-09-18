import { useEffect, useState } from 'react';

const historyKey = 'ssMusicNavigation';

export function createNavigationHistory(browser) {
  const listeners = new Set();
  let listening = false;
  let closing = false;
  let destinationAfterClose = null;

  function pageState() {
    let state = browser.history.state?.[historyKey];
    if (!state) {
      state = { page: `${Date.now()}-${Math.random()}`, lyrics: false };
      browser.history.replaceState({ ...browser.history.state, [historyKey]: state }, '');
    }
    return state;
  }

  let currentPage = pageState().page;
  let lyricsOpen = pageState().lyrics;

  function notify(routeChanged = false) {
    for (const listener of listeners) listener({ routeChanged, lyricsOpen });
  }

  function updateListener() {
    const needed = listeners.size > 0 || closing;
    if (needed === listening) return;
    browser[needed ? 'addEventListener' : 'removeEventListener']('popstate', onPopState);
    listening = needed;
  }

  function pushLyrics() {
    browser.history.pushState({
      ...browser.history.state,
      [historyKey]: { ...pageState(), lyrics: true }
    }, '');
  }

  function navigate(destination) {
    lyricsOpen = false;
    if (closing) {
      // Wait for our asynchronous Back before pushing a new route.
      destinationAfterClose = destination;
      notify();
      return;
    }
    const replace = pageState().lyrics;
    currentPage = `${Date.now()}-${Math.random()}`;
    browser.history[replace ? 'replaceState' : 'pushState']({
      [historyKey]: { page: currentPage, lyrics: false }
    }, '', destination);
    notify(true);
    browser.scrollTo(0, 0);
  }

  function onPopState() {
    const state = pageState();
    // Synthetic popstate events must not complete a pending history.back().
    if (closing && state.page === currentPage && state.lyrics) return;
    const routeChanged = state.page !== currentPage;
    currentPage = state.page;
    if (closing) {
      closing = false;
      if (destinationAfterClose !== null) {
        const destination = destinationAfterClose;
        destinationAfterClose = null;
        navigate(destination);
        updateListener();
        return;
      }
      // A rapid reopen must wait until Back has consumed the old overlay entry.
      if (lyricsOpen && !routeChanged && !state.lyrics) pushLyrics();
      else lyricsOpen = Boolean(state.lyrics);
    } else lyricsOpen = Boolean(state.lyrics);
    notify(routeChanged);
    updateListener();
  }

  return {
    navigate,
    setLyricsOpen(open) {
      lyricsOpen = open;
      if (!closing) {
        if (open && !pageState().lyrics) pushLyrics();
        else if (!open && pageState().lyrics) {
          closing = true;
          updateListener();
          browser.history.back();
        }
      }
      notify();
    },
    subscribe(listener) {
      if (!listening) {
        currentPage = pageState().page;
        lyricsOpen = Boolean(pageState().lyrics);
      }
      listeners.add(listener);
      updateListener();
      listener({ routeChanged: false, lyricsOpen });
      return () => { listeners.delete(listener); updateListener(); };
    }
  };
}

let history;
export function navigationHistory() {
  return history ||= createNavigationHistory(window);
}

export function navigate(destination) { navigationHistory().navigate(destination); }

export function useNavigation() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const unsubscribe = navigationHistory().subscribe(({ routeChanged }) => {
      if (routeChanged) setRevision((current) => current + 1);
    });
    const followLink = (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest('a[href]');
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || !/^\/(?:job(?:\/[^/]+(?:\/player)?)?|health|settings|admin(?:\/users\/[^/]+)?)?\/?$/.test(url.pathname) || url.hash) return;
      event.preventDefault();
      navigate(url.pathname + url.search);
    };
    document.addEventListener('click', followLink);
    return () => {
      unsubscribe();
      document.removeEventListener('click', followLink);
    };
  }, []);
  return revision;
}