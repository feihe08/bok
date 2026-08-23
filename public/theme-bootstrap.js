(function () {
  'use strict';

  // Apply the synchronous bootstrap cache before the page paints.
  try {
    var theme = window.localStorage.getItem('bok-theme');
    if (theme !== 'light' && theme !== 'dark') return;

    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch {
    // Ignore storage failures and let the page use its default appearance.
  }
})();
