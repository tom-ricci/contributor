# contributor
### Turn your commits into contributions!

Contributor is a little utility to add commits to your GitHub contribution table to make up for GitHub's shortcomings with assuming what's a contribution or not.

For example, this may be useful when you've committed 700 times to your project but GitHub doesn't consider them contributions because the repository is a fork. Even though you have no intention to merge your fork into the parent repository and it's only a fork in the first place because its easier to update your dependencies that way, GitHub still doesn't have an option to set your fork's main branch to be reconigized as worthy of contributions. Or maybe you're working on that same project and your software has multiple stable, main branches but only one of them can be the official main branch and the one you mainly contribute to just so happens to not be that branch. No that totally hasen't happened to me ever..totally...

## Installation
1. Create a repository out of this template.
2. Edit `sources.txt` to add your sources (repositories with the commits you want to add). On each line, you should add the following information in the format below, seperated by spaces. The repo ID is the ID Contributor will refer to it by. Using IDs, you can change the link and branch of a source without Contributor recommitting past commits.
```
<Repo Link> <Branch> <Repo ID>
```
4. Edit `author.txt` and, on the first line, add the author of the commits you wish to convert. This must be the exact string you used in the author of the commits, as Contributor uses this to find your commits.
5. Edit `credentials.sh`, and follow the instructions to add your Git credentials (don't worry, it's only public information, nothing sensitive!)

## Usage
Go to Actions > Update Contributions and dispatch the workflow. The workflow is ran on dispatch, so make sure to do this whenever you want to update your contributions.
> Note:\
> Contributor sets the author dates of your converted commits to the exact same author dates as the real ones, so you don't have to worry about timing. You can dispatch the workflow as often or as rarely as you want&mdash;your contributions will always show up on the correct dates.

## How it Works
Every time you dispatch the workflow, Contributor clones your sources and gets every commit in each repository. It then removes commits you didn't create, according to their authors. Then, it formats the subjects of all of your commits into Contributor's specific format. Since all commits Contributor makes are formatted in the same way, Contributor can search for and remove commits it's already committed. Finally, Contributor sets your Git credentials, commits the remaining commits to itself, and pushes itself upstream.
