const fs = require('fs');
const path = require('path');

const projectDir = __dirname;
const docsDir = path.join(projectDir, 'docs');
const outputFile = path.join(docsDir, 'whole-ethos.md');
const outputTitle = 'On Ethos (Complete)';
const outputDescription =
    'This document contains the complete compilation of all ethos documentation in the order it appears in the Docusaurus sidebar.';
const outputSlug = '/whole-ethos';
const publicSiteBase = 'https://ctzurcanu.github.io/ethos';
const rawStaticBase =
    'https://raw.githubusercontent.com/ctzurcanu/ethos/refs/heads/main/static/';
const dryRun = process.argv.includes('--dry-run');

function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const frontmatter = match ? match[1] : '';
    const sidebarPosition = frontmatter.match(/^sidebar_position:\s*([0-9]+(?:\.[0-9]+)?)/m);
    const title = frontmatter.match(/^title:\s*(.+)$/m);
    const slug = frontmatter.match(/^slug:\s*(.+)$/m);
    const unlisted = /^unlisted:\s*true\s*$/im.test(frontmatter);

    return {
        sidebarPosition: sidebarPosition ? Number(sidebarPosition[1]) : Number.POSITIVE_INFINITY,
        title: title ? title[1].trim().replace(/^['"]|['"]$/g, '') : '',
        slug: slug ? slug[1].trim().replace(/^['"]|['"]$/g, '') : '',
        unlisted,
    };
}

function collectMarkdownFiles(directory) {
    return fs
        .readdirSync(directory, {withFileTypes: true})
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((entry) => {
            const entryPath = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                return collectMarkdownFiles(entryPath);
            }

            return entry.isFile() && entry.name.endsWith('.md') ? [entryPath] : [];
        });
}

function loadDocuments() {
    const generatedOutputPaths = new Set([
        path.relative(docsDir, outputFile),
        'ethos_whole.md',
        'whole-ethos.md',
    ]);

    return new Map(
        collectMarkdownFiles(docsDir)
            .filter((filePath) => !generatedOutputPaths.has(path.relative(docsDir, filePath)))
            .map((filePath) => {
                const relativePath = path.relative(docsDir, filePath).split(path.sep).join('/');
                const source = fs.readFileSync(filePath, 'utf8');

                return [
                    relativePath,
                    {
                        filePath,
                        relativePath,
                        ...parseFrontmatter(source),
                    },
                ];
            })
            .filter(([, document]) => !document.unlisted),
    );
}

function compareSidebarItems(left, right) {
    if (left.sidebarPosition !== right.sidebarPosition) {
        return left.sidebarPosition - right.sidebarPosition;
    }

    // Docusaurus places regular documents before categories at the same position.
    if (left.kind !== right.kind) {
        return left.kind === 'document' ? -1 : 1;
    }

    return (left.title || left.name).localeCompare(right.title || right.name);
}

function loadCategoryMetadata(directory) {
    const metadataPath = path.join(docsDir, ...directory.split('/'), '_category_.json');

    if (!fs.existsSync(metadataPath)) {
        return {};
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    return {
        sidebarPosition:
            typeof metadata.position === 'number' ? metadata.position : undefined,
        title: typeof metadata.label === 'string' ? metadata.label : '',
    };
}

function getSidebarOrderedFiles(documents) {
    const documentsByDirectory = new Map();
    const directories = new Set(['']);

    for (const document of documents.values()) {
        const dirname = path.posix.dirname(document.relativePath);
        const directory = dirname === '.' ? '' : dirname;

        if (!documentsByDirectory.has(directory)) {
            documentsByDirectory.set(directory, []);
        }
        documentsByDirectory.get(directory).push(document);

        let parent = directory;
        while (parent) {
            directories.add(parent);
            const parentDirectory = path.posix.dirname(parent);
            parent = parentDirectory === '.' ? '' : parentDirectory;
        }
    }

    for (const directory of directories) {
        if (!documentsByDirectory.has(directory)) {
            documentsByDirectory.set(directory, []);
        }
    }

    function directoryIndex(directory) {
        return documents.get(directory ? `${directory}/index.md` : 'index.md');
    }

    function childDirectories(directory) {
        const prefix = directory ? `${directory}/` : '';
        return [...directories]
            .filter((candidate) => {
                if (!candidate.startsWith(prefix) || candidate === directory) {
                    return false;
                }

                const remainder = candidate.slice(prefix.length);
                return remainder.length > 0 && !remainder.includes('/');
            })
            .map((candidate) => {
                const index = directoryIndex(candidate);
                const category = loadCategoryMetadata(candidate);

                return {
                    kind: 'category',
                    name: path.posix.basename(candidate),
                    sidebarPosition:
                        category.sidebarPosition ??
                        index?.sidebarPosition ??
                        Number.POSITIVE_INFINITY,
                    title: category.title || index?.title || '',
                    directory: candidate,
                };
            });
    }

    function flattenDirectory(directory, isRoot = false) {
        const index = directoryIndex(directory);
        const directDocuments = (documentsByDirectory.get(directory) || [])
            .filter((document) => isRoot || document !== index)
            .map((document) => ({...document, kind: 'document', name: path.posix.basename(document.relativePath)}));
        const items = [...directDocuments, ...childDirectories(directory)].sort(compareSidebarItems);
        const orderedFiles = [];

        if (!isRoot && index) {
            orderedFiles.push(index.relativePath);
        }

        for (const item of items) {
            if (item.kind === 'document') {
                orderedFiles.push(item.relativePath);
            } else {
                orderedFiles.push(...flattenDirectory(item.directory));
            }
        }

        return orderedFiles;
    }

    return flattenDirectory('', true);
}

function rewriteStaticImageUrls(content) {
    // Markdown image paths in the source docs point at Docusaurus' static routes.
    // The compiled document is also useful outside the site, so make these links
    // independent of the document's hosting location.
    let rewritten = content.replace(
        /(!\[[^\]]*\]\(\s*)(?:<)?\/((?:images|img)\/[^\s)>]+)(?:>)?/g,
        (_, prefix, staticPath) => `${prefix}${rawStaticBase}${staticPath}`,
    );

    // Also cover HTML image tags if one is added to the docs later.
    rewritten = rewritten.replace(
        /(\bsrc\s*=\s*["'])\/((?:images|img)\/[^"']+)/gi,
        (_, prefix, staticPath) => `${prefix}${rawStaticBase}${staticPath}`,
    );

    return rewritten;
}

function getPublicUrl(route) {
    return `${publicSiteBase}${route.startsWith('/') ? route : `/${route}`}`;
}

function normalizeMarkdownRoute(route) {
    if (route.endsWith('/index.md')) {
        return `${route.slice(0, -'/index.md'.length)}/`;
    }

    return route.endsWith('.md') ? route.slice(0, -'.md'.length) : route;
}

function getDocumentRoute(document) {
    if (document.slug) {
        return document.slug;
    }

    if (document.relativePath === 'index.md') {
        return '/';
    }

    if (document.relativePath.endsWith('/index.md')) {
        return `/${document.relativePath.slice(0, -'/index.md'.length)}/`;
    }

    return `/${document.relativePath.slice(0, -'.md'.length)}`;
}

function resolveDocumentLink(sourceRelativePath, target, documents) {
    const suffixStart = target.search(/[?#]/);
    const targetPath = suffixStart === -1 ? target : target.slice(0, suffixStart);
    const suffix = suffixStart === -1 ? '' : target.slice(suffixStart);

    if (!targetPath || targetPath.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(targetPath)) {
        return null;
    }

    // Root-relative links are internal to this source project. Make them absolute
    // so the compiled document remains portable when copied into another site.
    if (targetPath.startsWith('/')) {
        return `${getPublicUrl(normalizeMarkdownRoute(targetPath))}${suffix}`;
    }

    const sourceDirectory = path.posix.dirname(sourceRelativePath);
    const baseDirectory = sourceDirectory === '.' ? '' : sourceDirectory;
    const normalizedTarget = path.posix.normalize(path.posix.join(baseDirectory, targetPath));
    const candidates = [normalizedTarget];

    if (normalizedTarget.endsWith('/')) {
        candidates.push(`${normalizedTarget}index.md`);
    } else if (!normalizedTarget.endsWith('.md')) {
        candidates.push(`${normalizedTarget}.md`);
    }

    const document = candidates
        .map((candidate) => documents.get(candidate))
        .find(Boolean);

    if (document) {
        return `${getPublicUrl(getDocumentRoute(document))}${suffix}`;
    }

    // Preserve relative links to static files while making them portable. A missing
    // Markdown document is almost certainly an authoring error and should fail fast.
    if (/\.mdx?$/i.test(normalizedTarget)) {
        throw new Error(`Unresolved Markdown link in ${sourceRelativePath}: ${target}`);
    }

    return `${getPublicUrl(`/${normalizedTarget}`)}${suffix}`;
}

function rewriteDocumentLinks(content, sourceRelativePath, documents) {
    let rewritten = content.replace(
        /(\[[^\]]*\]\(\s*)(<[^>]+>|[^\s)]+)/g,
        (match, prefix, targetToken) => {
            const isAngleBracketTarget = targetToken.startsWith('<') && targetToken.endsWith('>');
            const target = isAngleBracketTarget ? targetToken.slice(1, -1) : targetToken;
            const resolvedTarget = resolveDocumentLink(sourceRelativePath, target, documents);

            if (!resolvedTarget) {
                return match;
            }

            const replacement = isAngleBracketTarget ? `<${resolvedTarget}>` : resolvedTarget;
            return `${prefix}${replacement}`;
        },
    );

    // Markdown is the normal source format, but root-relative HTML links should
    // obey the same portability rule.
    rewritten = rewritten.replace(
        /(\bhref\s*=\s*["'])(\/[^"']+)(["'])/gi,
        (_, prefix, target, suffix) => `${prefix}${getPublicUrl(normalizeMarkdownRoute(target))}${suffix}`,
    );

    return rewritten;
}

function readMarkdownFile(document, documents) {
    const filePath = document.filePath;
    const source = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');

    // Remove YAML frontmatter only when it occurs at the start of the file.
    let cleaned = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    // Navigation links are useful on individual pages but not in the compilation.
    cleaned = cleaned.replace(/^\s*\[back\]\([^)]*\)\s*$/gim, '');
    // Rewrite images first so Markdown image syntax is not mistaken for a document link.
    cleaned = rewriteStaticImageUrls(cleaned);
    // Resolve internal links against their original source document and canonical
    // site. Leaving them relative or root-relative would make them point into any
    // repository that later imports this compiled document.
    cleaned = rewriteDocumentLinks(cleaned, document.relativePath, documents);
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
}

function buildWholeDocs() {
    const documents = loadDocuments();
    const orderedFiles = getSidebarOrderedFiles(documents);

    let output = `---\nunlisted: true\nslug: ${outputSlug}\n---\n\n# ${outputTitle}\n\n`;
    output += `${outputDescription}\n\n`;
    output += '---\n\n';

    for (const relativePath of orderedFiles) {
        const content = readMarkdownFile(documents.get(relativePath), documents);

        if (content) {
            output += `${content}\n\n---\n\n`;
        }
    }

    output = `${output.trimEnd()}\n`;

    if (dryRun) {
        console.log('\nDry run successful; no files were written.');
    } else if (fs.existsSync(outputFile) && fs.readFileSync(outputFile, 'utf8') === output) {
        console.log(`\n${path.relative(projectDir, outputFile)} is already up to date.`);
    } else {
        fs.writeFileSync(outputFile, output);
        console.log(`\nBuilt ${path.relative(projectDir, outputFile)} successfully.`);
    }

    console.log(`Compiled: ${orderedFiles.length} files`);
    console.log(`Total Markdown docs found: ${documents.size} files`);
}

buildWholeDocs();
