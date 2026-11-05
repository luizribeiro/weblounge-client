import {
  appBadgeKey,
  notificationCountsKey,
  openPushDatabase,
  pushStateStore,
  requestResult,
  transactionDone,
} from "./push-database";
import {
  decodeNotificationState,
  encodeNotificationState,
  type NotificationState,
  notificationStateTotal,
} from "./push-notification-state";

export async function updateNotificationState(
  update: (state: NotificationState) => void,
  factory: IDBFactory = indexedDB,
): Promise<number> {
  const database = await openPushDatabase(factory);
  try {
    const transaction = database.transaction(pushStateStore, "readwrite");
    const store = transaction.objectStore(pushStateStore);
    const state = decodeNotificationState(
      await requestResult(store.get(notificationCountsKey)),
    );
    update(state);
    const total = notificationStateTotal(state);
    store.put(encodeNotificationState(state), notificationCountsKey);
    store.put(total, appBadgeKey);
    await transactionDone(transaction);
    return total;
  } finally {
    database.close();
  }
}

export async function readNotificationState(
  factory: IDBFactory = indexedDB,
): Promise<NotificationState> {
  const database = await openPushDatabase(factory);
  try {
    const transaction = database.transaction(pushStateStore, "readonly");
    const state = decodeNotificationState(
      await requestResult(
        transaction.objectStore(pushStateStore).get(notificationCountsKey),
      ),
    );
    await transactionDone(transaction);
    return state;
  } finally {
    database.close();
  }
}
