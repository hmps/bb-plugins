// Better Sidebar (bb-plugin-t3sidebar) — an inbox-style replacement for bb's sidebar thread
// list, and the reference example for `app.slots.experimental_threadList`.
//
// The idea it is built around: the list NEVER re-orders itself. Threads sort
// by creation time, newest first, and hold that place. Status is carried by
// each card, not by position, so the sidebar only moves when you act.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ThreadInbox } from "./src/ThreadInbox";
import { ParentChip } from "./src/ParentChip";
import { SubagentsChip } from "./src/SubagentsChip";
import { ProjectColorsSection } from "./src/ProjectColorsSection";

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "inbox",
    title: "Better Sidebar (inbox)",
    description: "One flat list of cards, newest first, that never re-orders.",
    component: ThreadInbox,
  });

  // The badge under each card title reads as a project only if the colour is
  // the user's own choice, so the palette lives in settings.
  app.slots.settingsSection({
    id: "project-colors",
    title: "Project colours",
    description: "The badge colour each project gets in the sidebar.",
    component: ProjectColorsSection,
  });

  // Registered first, so it renders on the left of the children chip: the
  // header then reads up (parent) then down (children).
  //
  // The hidden child is otherwise a dead end — it is not in the list, so this
  // chip is its only route back to the parent.
  app.slots.experimental_threadHeaderAction({
    id: "parent",
    title: "Parent thread",
    component: ParentChip,
  });

  // A flat inbox has nowhere to nest child threads, so the list hides them
  // and this chip gives them a home on their parent's header.
  app.slots.experimental_threadHeaderAction({
    id: "children",
    title: "Child threads",
    component: SubagentsChip,
  });
});
