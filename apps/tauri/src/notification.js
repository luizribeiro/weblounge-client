(() => {
  const PERMISSIONS = ["default", "denied", "granted"];
  const instances = new Map();
  const ids = new WeakMap();
  let permission = PERMISSIONS.includes(window.__weblounge_initial_permission)
    ? window.__weblounge_initial_permission
    : "default";
  let untaggedCount = 0;

  let pendingPermissionRequest = null;
  let postsAndCloses = Promise.resolve();

  const invoke = (command, args) =>
    Promise.resolve().then(() =>
      window.__TAURI_INTERNALS__?.invoke(command, args),
    );

  const invokeInOrder = (command, args) => {
    const result = postsAndCloses.then(() => invoke(command, args));
    postsAndCloses = result.catch(() => undefined);
    return result;
  };

  const idFor = (tag) =>
    tag === undefined || tag === ""
      ? `weblounge-untagged-${(untaggedCount += 1)}`
      : String(tag);

  class Notification {
    constructor(title, options = {}) {
      const id = idFor(options?.tag);
      this.onclick = null;
      ids.set(this, id);
      instances.set(id, this);
      invokeInOrder("post_notification", {
        id,
        title: String(title),
        body: options?.body === undefined ? null : String(options.body),
      }).catch(() => undefined);
    }

    static get permission() {
      return permission;
    }

    static requestPermission() {
      pendingPermissionRequest ??= invoke("request_notification_permission")
        .then((result) => {
          if (PERMISSIONS.includes(result)) {
            permission = result;
          }
        })
        .catch(() => undefined)
        .then(() => {
          pendingPermissionRequest = null;
          return permission;
        });
      return pendingPermissionRequest;
    }

    close() {
      const id = ids.get(this);
      if (instances.get(id) !== this) {
        return;
      }
      instances.delete(id);
      invokeInOrder("close_notification", { id }).catch(() => undefined);
    }
  }

  Object.defineProperty(window, "Notification", {
    configurable: true,
    writable: true,
    value: Notification,
  });
  Object.defineProperty(window, "__weblounge_notifications", {
    value: Object.freeze({
      click: (id) => {
        const instance = instances.get(id);
        instances.delete(id);
        instance?.onclick?.call(instance);
      },
    }),
  });
})();
