# What's happening when importing lodash modules on-demand?

### Lodash gets much larger

- Prebuilt lodash as a single module - 71kb minified
- Individually import all lodash modules - **133kb** minified

### Lodash produces plenty of small modules

- Importing only one `"lodash/map"`, introducing **121** lodash modules

### Lodash gets duplicate codes

- E.g. `var funcTag = '[object Function]';` declaration is duplicated in multiple places
