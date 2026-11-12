(() => {
  const invokeBadge = (value) =>
    window.__TAURI_INTERNALS__.invoke("plugin:window|set_badge_count", {
      value,
    });

  Object.defineProperties(navigator, {
    setAppBadge: {
      configurable: true,
      value: (contents) => {
        if (contents === undefined) {
          return invokeBadge(1);
        }
        const count = Math.trunc(Number(contents));
        if (!Number.isFinite(count) || count < 0) {
          return Promise.reject(new TypeError("Invalid badge contents"));
        }
        return invokeBadge(count === 0 ? null : count);
      },
    },
    clearAppBadge: {
      configurable: true,
      value: () => invokeBadge(null),
    },
  });
})();
