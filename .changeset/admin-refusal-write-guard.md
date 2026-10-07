---
"@otta-sh/plugin": patch
---

The "Not saved — … Nothing was changed." banner is now guarded structurally: the
list/detail scaffold hands each custom action a watching proxy of its client and shows the
refusal banner only when no write is counted: a non-read call counts from the moment it is
called (so one still in flight counts) and is cleared only if that same call is refused
with `CommerceInputError`. A refusal that follows or accompanies a write keeps "Action
outcome unknown". The refusal wording for an ID now
names both spaces and accented characters, which the boundary's one reason covers.
