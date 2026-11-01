import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Composer } from "../src/features/composer/Composer";
import { migrateDraft } from "../src/features/composer/draft-storage";
import { installPlatformEnvironment } from "../src/platform/environment";
import "../src/styles/base.css";

const nickKey = "test:nick=alice";
const accountKey = "test:account=alice-account";
const accountKnownKey = "weblounge:e2e:account-known";
const root = document.getElementById("root");
if (root === null) throw new Error("missing draft migration root");
installPlatformEnvironment(root, window);
render(() => <Harness />, root);

function Harness() {
  const [draftKey, setDraftKey] = createSignal(
    sessionStorage.getItem(accountKnownKey) === "1" ? accountKey : nickKey,
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
          migrateDraft(nickKey, accountKey);
          sessionStorage.setItem(accountKnownKey, "1");
          setDraftKey(accountKey);
        }}
        type="button"
      >
        Account known
      </button>
    </main>
  );
}
