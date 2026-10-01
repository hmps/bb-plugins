// Custom Model Picker — one composer action in the thread and new-thread
// composers: the model picker, and in a thread composer a context usage ring
// on its right. Like the native picker, the action does not show in the
// compact layout: bb renders no composer actions there.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ContextRing } from "./src/ContextRing";
import { ModelPicker } from "./src/ModelPicker";

function PickerAction() {
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <ModelPicker />
      <ContextRing />
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "custom-model-picker",
    // setSelection rejects in queued-message editors and side chats.
    scopes: ["thread", "new-thread"],
    actions: [{ id: "model", component: PickerAction }],
  });
});
