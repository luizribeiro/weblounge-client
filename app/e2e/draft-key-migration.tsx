import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Composer } from "../src/features/composer/Composer";
import { migrateDraft } from "../src/features/composer/draft-storage";
import { installPlatformEnvironment } from "../src/platform/environment";
import "../src/styles/base.css";

const nickKey = "test:nick=alice";
const accountKey = "test:account=alice-account";
const migratedKey = "weblounge:e2e:nick-key-migrated";
const root = document.getElementById("root");
if (root === null) throw new Error("missing draft migration root");
installPlatformEnvironment(root, window);
render(() => <Harness />, root);

function Harness() {
  const [draftKey, setDraftKey] = createSignal(
    sessionStorage.getItem(migratedKey) === "1" ? nickKey : accountKey,
  );
  return (
    <main>
      <Composer
        bufferId={2}
        bufferTitle="alice"
        commandSpecs={[]}
        draftKey={draftKey()}
        onSend={() => {}}
      />
      <button
        onClick={() => {
          migrateDraft(accountKey, nickKey);
          sessionStorage.setItem(migratedKey, "1");
          setDraftKey(nickKey);
        }}
        type="button"
      >
        Migrate identity
      </button>
    </main>
  );
}
