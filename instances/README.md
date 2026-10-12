# Instances

One folder per place netmap is deployed. Everything in here except this README and `example/` is ignored by
git: instance folders name hosts, users and networks, and can hold notes you don't want published.

```
instances/<name>/
  instance.env    where and how to deploy (read by scripts/deploy.sh)
  config.json     the instance's server/config.json (optional; copied over on every deploy)
  NOTES.md        how it's set up, what's on that network, anything worth remembering
```

Deploy: `scripts/deploy.sh <name>` (add `--dry-run` first to see what it will do). It builds the web app
locally, copies the code over SSH, runs `scripts/install.sh` there and restarts the service. It never copies or
touches the instance's database: devices and their logins are added in that instance's web page.

Start a new one: `cp -r instances/example instances/<name>` and edit the three files.
