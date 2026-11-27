# A live inbox dismiss check goes on to real items

date: 2026-11-27
status: verified
scope: live browser checks of inbox actions (Dismiss, `e`, Snooze, Done) on Ethereal-Titan
keywords: inbox, dismiss, e key, live check, test items, unread, read_at, browser-automation
evidence: inbox 0.1.9 check. After TEST 1 was dismissed, the page opened the next open item. The list puts unread items first, so the next item was a real one, and the second `e` dismissed it. Opening a real unread item also marked it read.
action: Make test items with `bb inbox ask` and open each one first, so they are read and next to each other in the list. Before each action, check that the title is a test title, and stop if not. Before the check, record the ids of unread items. After it, set `read_at` to null for any of them that your visits marked read.
verify: after the check, `bb inbox list` shows no test item, every real item is still open, and the unread ids match the record.
retire-when: the inbox has a reopen action, or a test mode that keeps checks off real items.
