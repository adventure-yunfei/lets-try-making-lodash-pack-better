# What's happening when importing lodash modules on-demand?

### Lodash gets much larger

- Prebuilt lodash as a single module - 71kb minified
- Individually import all lodash modules - **116kb** minified

### Lodash produces plenty of small modules

- Importing only one `"lodash/map"`, introducing **121** lodash modules

### Lodash gets duplicate codes

- E.g. `var funcTag = '[object Function]';` declaration is duplicated in multiple places

# Road Map

- First: just merge them into one module
  - full lodash modules size decreased to 105.7kb
  - keep only one dependency now
- Second: move all literal variables into top and remove duplicate var
  - size descreased to 103.3kb (only 2kb less... re-tested and found out that all literal declaration source code only takes 10kb (among 725kb))
