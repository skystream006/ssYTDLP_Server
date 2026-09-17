import { useEffect, useState } from 'react';

export function navigate(destination) {
  window.history.pushState(null, '', destination);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

export function useNavigation() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = () => setRevision((current) => current + 1);
    const followLink = (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest('a[href]');
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || !/^\/(?:job(?:\/[^/]+(?:\/player)?)?|health|settings|admin(?:\/users\/[^/]+)?)?\/?$/.test(url.pathname) || url.hash) return;
      event.preventDefault();
      navigate(url.pathname + url.search);
    };
    window.addEventListener('popstate', update);
    document.addEventListener('click', followLink);
    return () => {
      window.removeEventListener('popstate', update);
      document.removeEventListener('click', followLink);
    };
  }, []);
  return revision;
}