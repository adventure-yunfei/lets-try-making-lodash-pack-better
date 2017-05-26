const _path = require('path');
const fs = require('fs-extra');

const babylon = require('babylon');
const traverse = require('babel-traverse').default;
const t = require('babel-types');
const generator = require('babel-generator').default;
const lodashModuleBasePath = _path.dirname(require.resolve('lodash'));

function createExportVar(id, body) {
    return t.variableDeclaration('var', [
        t.variableDeclarator(
            t.identifier(id),
            t.callExpression(
                t.functionExpression(null, [], t.blockStatement(body)),
                []
            )
        )
    ]);
}

function inferLodashModuleVarName(modulePath) {
    const relativePath = _path.relative(lodashModuleBasePath, modulePath);
    return relativePath.replace('.js', '').replace(/[\\/]/g, '_');
}

function uniqLiteralVars(literalVars) {
    const result = [];
    const idMap = {};
    literalVars.forEach((literalVar) => {
        const varName = literalVar.id.name;
        if (idMap[varName]) {
            if (idMap[varName].init.value !== literalVar.init.value) {
                throw new Error(`Literal variable declarator conflict: ${varName}`);
            }
        } else {
            result.push(literalVar);
            idMap[varName] = literalVar;
        }
    });
    return result;
}

function transformModuleToVar(modulePath) {
    const moduleVar = inferLodashModuleVarName(modulePath);
    const code = fs.readFileSync(modulePath, 'utf8');
    const ast = babylon.parse(code);
    const dependencies = [];
    const literalVars = [];
    let rootScope = null;
    const isExportsAssign = (assignmentNode) => {
        const { left } = assignmentNode;
        return (left.type === 'MemberExpression' && left.object.type === 'Identifier' && left.object.name === 'module')
            || (left.type === 'Identifier' && left.name === 'exports');
    };

    traverse(ast, {
        // Wrap module with IIFE func to create namespace
        Program: {
            enter(path) {
                rootScope = path.scope;
            },
            exit(path) {
                path.node.body = [
                    createExportVar(moduleVar, path.node.body)
                ];
            }
        },

        // Replace "exports" with "return"
        AssignmentExpression: {
            exit(path) {
                if (isExportsAssign(path.node)) {
                    if (path.parent.type === 'ExpressionStatement') {
                        path.parentPath.replaceWith(
                            t.returnStatement(path.node.right)
                        );
                    } else {
                        throw new Error('module exports should be inside an ExpressionStatement');
                    }
                }
            }
        },

        // Replace "require" with namespace variable
        CallExpression(path) {
            const { node, parent } = path;
            if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
                const { arguments: args } = node;
                if (args.length === 1 && args[0].type === 'StringLiteral') {
                    const importedModulePath = args[0].value;
                    const tgtVarName = importedModulePath.replace(/^(.*[\\\/])*/, '');
                    dependencies.push(require.resolve(
                        _path.resolve(_path.dirname(modulePath), importedModulePath))
                    );
                    if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
                        // require for declaration
                        if (parent.id.name === tgtVarName) {
                            path.parentPath.remove();
                        } else {
                            parent.init = t.identifier(tgtVarName);
                        }
                        return;
                    } else if (parent.type === 'AssignmentExpression') {
                        if (parent.left.type === 'Identifier' && parent.left.name === tgtVarName) {
                            throw new Error('Conflict assignment with require');
                        }
                        parent.right = t.identifier(tgtVarName);
                        return;
                    }
                }
                throw new Error(`Unknown require call expression: require(${JSON.stringify(args)})`);
            }
        },

        // Extract literal declaration
        VariableDeclarator(path) {
            const { node } = path;
            if (path.scope === rootScope && node.id.type === 'Identifier') {
                const initType = node.init && node.init.type;
                if (initType === 'StringLiteral' || initType === 'NumericLiteral'
                    || initType === 'BooleanLiteral') {
                    literalVars.push(node);
                    path.remove();
                }
            }
        }
    });

    return {
        modulePath,
        ast,
        dependencies,
        literalVars,
        sourceCode: code
    };
}

function createMergedLodash(includedModules, outputFile = _path.resolve(__dirname, 'out.js')) {
    const includedModulePaths = includedModules.map(mod =>
        require.resolve(_path.resolve(lodashModuleBasePath, mod)));
    const moduleVars = [];
    const moduleVarMap = {};

    // First transfrom all modules code
    function transformModules(modPaths) {
        const newDependencies = modPaths.reduce((dependencies, modPath) => {
            if (!moduleVarMap[modPath]) {
                const modVar = transformModuleToVar(modPath);
                moduleVarMap[modPath] = modVar;
                moduleVars.push(modVar);
                dependencies = dependencies.concat(modVar.dependencies);
            }
            return dependencies;
        }, []);
        if (newDependencies.length) {
            transformModules(newDependencies);
        }
    }

    transformModules(includedModulePaths);

    // Then sort them
    moduleVars.forEach((modVar) => {
        modVar.dependencyMap = modVar.dependencies.reduce((acc, dep) => {
            acc[dep] = true;
            return acc;
        }, {});
    });
    const handledModuleVars = [];
    const handledModuleVarMap = {};
    function updateDependenciesDepth(modVar) {
        modVar.dependencies.forEach((dep) => {
            const handledModVar = handledModuleVarMap[dep];
            if (handledModVar && handledModVar.depth < modVar.depth + 1) {
                handledModVar.depth = modVar.depth + 1;
                updateDependenciesDepth(handledModVar);
            }
        });
    }
    moduleVars.forEach((modVar) => {
        const { modulePath } = modVar;
        modVar.depth = handledModuleVars.reduce((acc, m) => {
            if (m.dependencyMap[modulePath]) {
                acc = Math.max(acc, m.depth + 1);
            }
            return acc;
        }, 0);
        updateDependenciesDepth(modVar);
        handledModuleVars.push(modVar);
        handledModuleVarMap[modulePath] = modVar;
    });

    moduleVars.sort((a, b) => b.depth - a.depth);

    // Finally output them with only one module
    const exportedLodashVar = '__EXPORTED_LODASH__';
    const literalVars = moduleVars.reduce((acc, modVar) => acc.concat(modVar.literalVars), []);
    const literalDeclareAST = t.file(
        t.program([
            t.variableDeclaration('var', uniqLiteralVars(literalVars))
        ])
    );
    const exportAST = t.file(
        t.program(
            [
                t.variableDeclaration('var', [
                    t.variableDeclarator(
                        t.identifier(exportedLodashVar),
                        t.objectExpression([])
                    )
                ])
            ].concat(includedModulePaths.map((modPath) => {
                const modVarName = inferLodashModuleVarName(modPath);
                return t.expressionStatement(
                    t.assignmentExpression(
                        '=',
                        t.memberExpression(
                            t.identifier(exportedLodashVar),
                            t.identifier(modVarName)
                        ),
                        t.identifier(modVarName)
                    )
                );
            })).concat([
                t.expressionStatement(
                    t.assignmentExpression(
                        '=',
                        t.memberExpression(
                            t.identifier('module'),
                            t.identifier('exports')
                        ),
                        t.identifier(exportedLodashVar)
                    )
                )
            ])
        ),
        [],
        []
    );

    const finalCode = [
        generator(literalDeclareAST, {}).code,
        ...(moduleVars.map((modVar) => {
            const code = generator(modVar.ast, {}, modVar.sourceCode).code;
            return `/* lodash module: ${_path.relative(lodashModuleBasePath, modVar.modulePath)} */\n${code}`;
        })),
        generator(exportAST, {}).code
    ].join('\n\n');
    fs.writeFileSync(outputFile, finalCode);
}

module.exports = createMergedLodash;

// test code
createMergedLodash(require('./lodash-modules').full);
