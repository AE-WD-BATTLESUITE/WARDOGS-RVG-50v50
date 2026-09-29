# Changing it, forking it, sending stuff back

## you probably dont need to fork

If you just want to RUN it, dont fork. Everything you configure lives in `config.json`,
which is a seperate file thats gitignored. Your settings never touch the code, so you can
pull updates whenever you like without losing anything:

```bash
git pull
```

Thats it. Your config stays exactly as it was.

If you only want to change WHAT it does rather than HOW it does it, check the Settings
table in the readme first. Cap, tolerance, cooldowns, clan grouping, which faction is
closed, the admin exempt list, the rescue, all of it is config. Most things people want to
change are allready a setting.

## if you do want to change the code

Fork it. Green Fork button, top right of the repo page. That gives you your own copy under
your own account that you can do what you like with.

```bash
git clone https://github.com/YOUR-NAME/WARDOGS-RVG-50v50.git
cd WARDOGS-RVG-50v50
node selftest.js
```

Get `36 passed, 0 failed` before you change anything, so you know your starting from a
working base.

Then change what you want, and run the tests again:

```bash
node selftest.js
```

If somthing goes red, you broke a rule. The test name tells you which one.

Before you open a PR that touches the placing logic, run the stress harness as well:

```bash
node stress.js
```

That throws 660 randomised servers at it with people joining, quitting and hopping sides,
and checks the invariants after every tick. Takes a couple of minutes. If it prints a seed,
paste that seed in the PR, becuase it reproduces the failure exactly.

## the licence

MIT. Use it, change it, sell it, rename it, build a business on it. No conditions.

The only thing I'll ask, and it is only an ask: it broadcasts one line by default, and if
the thing earns its keep on your server, leave it alone. If you'd rather it said somthing
else, or nothing, thats a config setting and youre not breaching anything. Theres a
section on it in the readme.

## sending changes back

Pull requests welcome. Before you open one:

1. `node selftest.js` passes.
2. If youve added behaviour, add a test for it. The file is `selftest.js`, the pattern is
   obvious, copy the nearest one.
3. If youve changed behaviour thats described in the readme, update the readme too.
   Otherwise the readme is now lying and somebody wastes an evening on it.

## what i will and wont take

**Will:** bug fixes, more game builds supported, better error messages, tests that catch
somthing the existing ones miss, docs that are clearer than mine.

**Wont, unless you can talk me round:** anything that lets it move a settled player mid
match. Thats the promise the whole thing is built on. Every server owner who leaves it
running is trusting that it wont pull somebody off a roof mid firefight, and the moment it
does that once, it gets uninstalled and it deserves to be.

The rules in the readme are the contract, not suggestions. If a change breaks one, its not
a balancer any more, its just somthing that shuffles people about.

## found a bug

Open an issue. Useful things to put in it:

- what you expected and what actualy happened
- the log lines around it
- your config with the password taken out
- how many players were on and roughly what the teams looked like

If its a security thing, see [SECURITY.md](SECURITY.md) first.
