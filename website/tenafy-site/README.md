# tenafy.com

The public marketing site. Plain static HTML and CSS, no build step.

Served by nginx straight from `/var/www/tenafy-site` on the droplet
(`server_name tenafy.com www.tenafy.com`).

## It was not in version control until 2026-09-07

It existed only on the droplet, last edited 16 June, with no history and no copy
anywhere else. A stray `rm` would have taken it with no way back. Everything here was
copied down from the live server as-is; the only content change in that first commit is
the sign-in links below.

## Deploying

There is nothing to build. Copy the files up and nginx serves them immediately:

    scp -i ~/.ssh/alexhome website/tenafy-site/*.html \
        website/tenafy-site/*.css website/tenafy-site/*.js \
        root@159.89.203.164:/var/www/tenafy-site/

Edit here and deploy. Editing on the droplet directly puts it back to having no history.

## Sign in

Both "Sign in" links on every page (header button and footer) point at
`https://platform.tenafy.com/tenant-portal/login`.

Note for whoever reads this next: every other call to action on the site is aimed at
landlords and agencies ("Run your entire portfolio", "Trusted by landlords & agencies"),
and their application is at `/login`, not `/tenant-portal/login`. Sending Sign in to the
tenant portal is a deliberate choice, not an oversight. If it ever needs to serve both,
the usual shape is "Sign in" for landlords plus a smaller "Tenant login" beside it.
