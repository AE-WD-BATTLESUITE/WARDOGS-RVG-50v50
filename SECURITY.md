# Security

## the one that actually bites people

`config.json` has your RCON password in it. Anybody who gets hold of that can do what they
like with your server. Its in `.gitignore` allready, but the usual accident is somebody
renaming it, or force adding it, and shoving the lot into a public repo.

Before your first push, check:

```bash
git status --porcelain | grep config.json
```

If that prints anything at all, stop and sort it out. The balancer will also shout at you
on startup if it spots your config sat in a git repo that isnt ignoring it.

**If you do leak it: change the RCON password on your server FIRST.** Then worry about the
git history. Rotating the password is the bit that actualy closes the hole. Scrubbing the
history without rotating does nothing, becuase whoever was watching allready has a copy.

## keeping the password out of files completly

You can hand it an environment variable name instead of the password itself:

```json
{ "name": "my box", "host": "10.0.0.5", "port": 7779, "tokenEnv": "WD_RCON_MYBOX" }
```

Then set `WD_RCON_MYBOX` in your service file or your shell. Nothing secret ends up
anywhere git can see it. It only ever reads the variable you name here, nothing else on
your machine.

## what this thing can and cant do

Seven calls, thats the lot:

| it can | it cannot |
|---|---|
| read the player list | ban anybody |
| read the map and score | kick anybody |
| read uptime | change your map |
| move one player to a faction | touch your server config |
| send a private line to a joiner | read your files |
| broadcast one line | see or log anybodys chat |
| restart the round, **only if you turn `rescue` on** | talk to anything except your own server |

That last one is the only call in here that interupts people, which is why `rescue` ships
switched off and why the validator is fussy about its settings. With `rescue` off it is six
calls and none of them can end a round.

It has no dependencies, no telemetry, and it dosent call home. Its two small files, you
can read the whole thing in ten minutes and check that yourself. Dont take my word for it.

## found somthing

Open an issue. If its genuinely sensitive, say so in the issue WITHOUT the details and
well sort out somewhere better to talk.
