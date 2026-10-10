import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import convertSourceMap from 'convert-source-map';
import { createInstrumenter } from 'istanbul-lib-instrument';
import TestExclude from 'test-exclude';

const packageRoot = resolve(import.meta.dirname, '..');

// Match NYC's resolved child configuration, additionally limiting instrumentation to package source.
export function shouldInstrument(filename, config) {
  const sourcePath = relative(resolve(packageRoot, 'src'), filename);
  if (!sourcePath || sourcePath === '..' || sourcePath.startsWith(`..${sep}`) || isAbsolute(sourcePath)) {
    return false;
  }
  const extension = [...new Set([].concat(config.extension || [], '.js').map((ext) => ext.toLowerCase()))];
  return new TestExclude({
    cwd: config.cwd || packageRoot,
    include: config.include,
    exclude: config.exclude,
    excludeNodeModules: config.excludeNodeModules !== false,
    extension,
  }).shouldInstrument(filename);
}

export async function load(url, context, nextLoad) {
  // The preceding ts-node loader must finish before Istanbul sees the module's JavaScript.
  const loaded = await nextLoad(url, context);
  if (!url.startsWith('file:') || loaded.format !== 'module' || loaded.source == null) return loaded;
  if (!process.env.NYC_CONFIG) throw new Error('Coverage loader requires resolved NYC_CONFIG');
  const config = JSON.parse(process.env.NYC_CONFIG);
  const filename = fileURLToPath(url);
  if (!shouldInstrument(filename, config) || config.instrument === false) return loaded;

  const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
  const inputMap = convertSourceMap.fromSource(source)?.toObject();
  const instrumenter = createInstrumenter({
    autoWrap: true,
    coverageVariable: '__coverage__',
    embedSource: true,
    compact: config.compact,
    preserveComments: config.preserveComments,
    produceSourceMap: config.produceSourceMap,
    ignoreClassMethods: [].concat(config.ignoreClassMethod || []),
    esModules: config.esModules,
    parserPlugins: config.parserPlugins,
  });
  // Do not swallow eligible parse/instrumentation failures or fall back to uninstrumented code.
  let instrumented = instrumenter.instrumentSync(convertSourceMap.removeComments(source), filename, inputMap);
  const outputMap = instrumenter.lastSourceMap();
  if (config.produceSourceMap && outputMap) {
    instrumented += `\n${convertSourceMap.fromObject(outputMap).toComment()}`;
  }
  return { ...loaded, source: instrumented };
}
