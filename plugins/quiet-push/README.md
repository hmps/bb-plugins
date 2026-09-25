# Quiet Push

bb's builtin Push notifications plugin sends a notification each time a
top-level thread ends a turn. Quiet Push lets an agent mute that notification
for one turn. The default stays the same: every turn notifies unless the agent
mutes it.

## How it works

The plugin gives top-level threads a `mute_notification` tool. Its
instructions tell the agent when to mute: an automated message started the
turn and the reply needs nothing from the user. The agent calls the tool
before it ends the turn.

When the muted turn ends, the plugin marks the thread read. The builtin
waits two seconds before it sends, and it skips a thread that was read after
the event. The mute therefore covers the mobile, web, and desktop channels.

Only a turn end is muted. A failed thread and a pending question still
notify. A muted turn also leaves no unread marker in the sidebar.

A mute lasts for one turn. A failed, archived, or deleted thread drops its
mute.

## Command

```sh
bb quiet-push mute                 # mute the current turn of this thread
bb quiet-push mute --thread <id>   # mute the current turn of another thread
```

The command is for agents that cannot call the tool.

## Notes

- The tool reaches a thread when its agent session starts. A thread that was
  already running gets it after its next session start.
- The plugin keeps mutes in memory. A plugin reload drops a pending mute, and
  that turn notifies.
- The builtin never notifies for child threads, so child threads do not get
  the tool.
