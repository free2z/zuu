#!/bin/bash

# Initialize submodules if --init flag is passed (for first-time setup after clone)
if [ "$1" = "--init" ]; then
    echo "Initializing all submodules..."
    git submodule update --init
    echo "========================================="
fi

# Iterate through each submodule defined in .gitmodules
git config -f .gitmodules --get-regexp '^submodule\..*\.path$' | while read path_key path
do
    # Get the branch name for this submodule
    branch_key=$(echo $path_key | sed 's/\.path$/.branch/')
    branch=$(git config -f .gitmodules --get "$branch_key")

    # Default to 'master' if no branch is defined
    branch=${branch:-master}

    echo "Updating submodule at path: $path"
    echo "Branch specified in .gitmodules: $branch"

    # Change to the submodule directory
    if [ -d "$path" ]; then
        (cd $path &&
            echo "Fetching latest changes from origin in submodule $path..." &&
            git fetch origin &&
            echo "Checking out branch $branch in submodule $path..." &&
            git checkout $branch &&
            echo "Pulling latest changes for branch $branch in submodule $path..." &&
            git pull origin $branch) || {
                echo "Error updating submodule $path on branch $branch"
            }
    else
        echo "Directory $path does not exist. Skipping..."
    fi

    echo "-----------------------------------------"
done
