import { batchedPromiseAll } from 'batched-promise-all'
import cliProgress from 'cli-progress'
import findUp from 'find-up'
import gitignoreToGlobs from 'gitignore-to-glob'
import globToRegex from 'glob-to-regexp'
import { groupBy } from 'lodash'
import os from 'os'
import {
    arrayMax,
    average,
    bfs,
    getFileOwners,
    gitDirectoryTree,
    makeHist,
    sum,
} from './support'

export type MyDirectoryTree = {
    path?: string
    depth?: number
    name?: string
    type: 'directory' | 'file'
    children?: MyDirectoryTree[]
    contributorsDetails?: Array <{
        percentage: number
        author: string
        accumulatedLinesCount: number
    }>
    topContributorDetails?: {
        percentage: number
        author: string
        accumulatedLinesCount: number
    }
}

const CONCURRENT_IO_LIMIT = os.cpus().length * 4

function getTreeLayersLeafFirst(tree: MyDirectoryTree) {
    const nodes: Array<MyDirectoryTree> = bfs(tree)
    const layers = groupBy(nodes, (x) => x.depth)
    // Object.keys(layers).forEach(key => {
    //     let value = layers[key];
    //     console.log('layers');
    //     console.log(key, value);
    // });

    const groups = Object.keys(layers)
        .map(Number)
        .sort((a, b) => a - b)
        .map((k) => layers[String(k)])
        .reverse()

    // Object.keys(groups).forEach(key => {
    //     let value = groups[key];
    //     console.log('groups1');
    //     console.log(key, value);
    // });
    return groups
}

// first create the tree object, do a reversed breadth first search, getting top contributors for every file and adding to a cache with { absPath, linesCount, topContributor, topContributorPercentage }, every directory has percentage as weighted average on its direct children, then print the tree
export async function makeTreeWithInfo(
    cwd,
    { silent = false, exclude = [] } = {},
): Promise<MyDirectoryTree> {
    // const gitignoreExclude = await getGitIgnoreRegexes()
    const tree = await gitDirectoryTree(cwd, {
        // exclude: [
        //     /node_modules/,
        //     /\.git/,
        //     ...gitignoreExclude,
        //     ...exclude.map((x) => new RegExp(x)),
        // ], // TODO add excludes
    })
    const layers = getTreeLayersLeafFirst(tree)
    if (!silent) {
        console.log(
            `processing ${
                layers.length
            } directory tree layers concurrently, with in average ${average(
                layers.map((x) => x.length),
            ).toFixed(1)} files each`,
        )
    }
    const bar = new cliProgress.SingleBar(
        { clearOnComplete: true },
        cliProgress.Presets.shades_classic,
    )
    if (!silent) {
        bar.start(layers.map((x) => x.length).reduce(sum, 0), 0)
    }
    let linesCounted = 0
    for (let nodes of layers) {
        await batchedPromiseAll(
            nodes,
            addContributorDetailsToNode,
            CONCURRENT_IO_LIMIT,
        )
        if (!silent) {
            linesCounted += nodes.length
            bar.update(linesCounted)
        }
    }
    bar.stop()

    return tree
}

const addContributorDetailsToNode = async (node: MyDirectoryTree) => {
    const isDir = node.type === 'directory'
    const filePath = node.path
    if (isDir && node?.children?.length) {

        // node.children.forEach(x => {
        //     console.log('node children -----');
        //     console.log(x.topContributorDetails.author);
        // });

        //All top contributors of nested files/directories
        const groups = groupBy(
            node.children || [],
            (x) => x.topContributorDetails.author,
        )

        // Object.keys(groups).forEach(key => {
        //     let value = groups[key];
        //     console.log('groups2');
        //     console.log(key, value);
        // });

        const totalLines = node.children
            .map((x) => x.topContributorDetails.accumulatedLinesCount)
            .reduce(sum, 0)
        const details = Object.keys(groups).map((author) => {
            const nodes = groups[author]
            const lines = nodes
                .map((x) => x.topContributorDetails.accumulatedLinesCount)
                .reduce(sum, 0)
            const percentage = lines / totalLines
            if (percentage > 1) {
                console.error('WARNING: got a percentage > 1')
            }
            return {
                author,
                lines,
                percentage,
            }
        })
        const { author, percentage, lines } = arrayMax(
            details,
            (x) => x.percentage,
        )
        node.topContributorDetails = {
            author,
            percentage,
            accumulatedLinesCount: lines,
        }
        // console.log('the trught !!!!!')
        // console.log(node.path)
        // console.log(node.contributorsDetails)

        return
    }

    //If its a file -bottom of recursion
    const authors = await getFileOwners({
        filePath,
    })

    //If there are no authors
    if (!authors?.length) {
        node.topContributorDetails = {
            percentage: 0,
            author: '',
            accumulatedLinesCount: 0,
        }
        return
    }

    const hist = makeHist(authors)
    const contributorsDetails = Object.keys(hist).map((author) => {
        const lines = hist[author]
        return {
            percentage: lines / authors.length,
            author,
            accumulatedLinesCount: lines,
        }
    })


    // contributorsDetails.forEach(x => {
    //     console.log('node children -----');
    //     contributorsDetails.forEach(detail => {
    //         console.log(detail.author);
    //         console.log(detail.accumulatedLinesCount);
    //         console.log(detail.percentage);
    //
    //     })
    // });

    node.topContributorDetails = arrayMax(
        contributorsDetails,
        (x) => x.percentage,
    )
    node.contributorsDetails = contributorsDetails
}

export async function getGitIgnoreRegexes() {
    try {
        const gitignorePath = await findUp('.gitignore')
        const globsToIgnore = gitignoreToGlobs(gitignorePath) || []
        return globsToIgnore.map((x) => globToRegex(x, { globstar: true }))
    } catch {
        return []
    }
}
