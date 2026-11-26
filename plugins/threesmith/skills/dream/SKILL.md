---
name: dream
description: Let Threesmith look back at past sessions on this machine and propose project hints, lessons to write, lessons to retire or merge and notes on noisy rules, each with its evidence; apply only what the user approves.
disable-model-invocation: true
argument-hint: "[all, optional]"
---

# Dream: learn from past sessions

While agents work, Threesmith keeps a few counters on this machine: API names that were looked up and did not exist
(with the name the installed three suggested), browser and console messages that no explanation or lesson covered
(as scrubbed templates), writes that were undone, lessons marked as wrong, and review findings marked as false
alarms. A dream reads them back. No model and no network: nothing leaves the machine, and nothing changes until a
proposal is applied.

1. **Dream.** Call `three_dream` with detail full (with `all: true` when $ARGUMENTS says all).
2. **Finish the drafts.** A draft lesson only has the message. For each one you can work out, find the cause with
   `three_api`, `three_explain` and `three_check`, then keep it with `three_lesson_add` and the message as `error`.
3. **Show, then ask.** List every proposal with its number, the evidence and the reason, plus the lessons you wrote.
   Ask the user which to apply.
4. **Apply what was approved:** `three_dream` with `apply` and the numbers.
5. **End with a short list:** what was applied, what was left, and that `three_undo` takes the hints back.

Project hints live in `.threesmith/hints.json` (only three.js API names, rule ids and tool names); commit it to share
them with the team. The session start shows them to the next agent, and `three_api`
shows a hint when an agent asks for the same missing name again. `THREESMITH_LEARN=0` turns the counters off.
