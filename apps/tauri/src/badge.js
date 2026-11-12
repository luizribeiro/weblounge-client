(() => {
  const invokeBadge = (value) =>
    window.__TAURI_INTERNALS__?.invoke("plugin:window|set_badge_count", {
      value,
    });

  const badgeValue = (contents) => {
    if (contents === undefined) {
      return 1;
    }
    const count = Math.trunc(Number(contents));
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError("Invalid badge contents");
    }
    return count === 0 ? null : count;
  };

  Object.defineProperties(navigator, {
    setAppBadge: {
      configurable: true,
      value: (contents) =>
        Promise.resolve().then(() => invokeBadge(badgeValue(contents))),
    },
    clearAppBadge: {
      configurable: true,
      value: () => Promise.resolve().then(() => invokeBadge(null)),
    },
  });
})();
