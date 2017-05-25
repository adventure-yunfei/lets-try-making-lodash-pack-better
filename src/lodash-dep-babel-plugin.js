const createMergedLodash = require('./create-merged-lodash');

const IMPORT_PATH = '__MERGED_LODASH__';
const IMPORTED_VAR = '__MERGED_LODASH__';

module.exports = function ({ types: t }) {
    return {
        pre(state) {
            this.importedLodashModules = [];
        },

        visitor: {
            ImportDeclaration(path, state) {
                const { node } = path;
                let match = null;
                if (node.source.type === 'StringLiteral' && (match = node.source.value.match(/^lodash\/(.+)$/))) {
                    const lodashModule = match[1];
                    let declaredVal = null;
                    node.specifiers.forEach((specifier) => {
                        if (specifier.type === 'ImportDefaultSpecifier') {
                            declaredVal = specifier.local.name;
                            specifier.loc.name = IMPORTED_VAR;
                        }
                    });
                    node.source.value = IMPORT_PATH;

                    // Add code: const foo = __MERGED_LODASH__.foo;
                    const declareNodeLeft = t.identifier(declaredVal);
                    const declareNodeRight = t.memberExpression(
                        t.identifier(IMPORTED_VAR),
                        t.identifier(lodashModule)
                    );
                    path.insertAfter(t.variableDeclaration('const', [t.variableDeclarator(declareNodeLeft, declareNodeRight)]));

                    this.importedLodashModules.push(lodashModule);
                }
            }
        },

        post(state) {
            createMergedLodash(this.importedLodashModules);
        }
    }
}
