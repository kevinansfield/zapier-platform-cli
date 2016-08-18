
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const browserify = require('browserify');
const through = require('through2');
const _ = require('lodash');
const AdmZip = require('adm-zip');
const fse = require('fs-extra');

const constants = require('../constants');

const {
  writeFile,
  readFile,
  copyDir,
  ensureDir,
  removeDir,
} = require('./files');

const {
  prettyJSONstringify,
  printStarting,
  printDone,
} = require('./display');

const {
  checkCredentials,
  upload,
} = require('./api');

const {
  runCommand,
  makePromise,
} = require('./misc');

const stripPath = (cwd, filePath) => filePath.split(cwd).pop();

// given an entry point, return a list of files that uses
// could probably be done better with module-deps...
// TODO: needs to include package.json files too i think
//   https://github.com/serverless/serverless-optimizer-plugin?
const browserifyFiles = (entryPoint) => {
  const cwd = entryPoint + '/';
  const argv = {
    noParse: [ undefined ],
    extensions: [],
    ignoreTransform: [],
    entries: [entryPoint + '/zapierwrapper.js'],
    fullPaths: false,
    builtins: false,
    commondir: false,
    bundleExternal: true,
    basedir: undefined,
    browserField: false,
    detectGlobals: true,
    insertGlobals: false,
    insertGlobalVars: {
      process: undefined,
      global: undefined,
      'Buffer.isBuffer': undefined,
      Buffer: undefined
    },
    ignoreMissing: false,
    debug: false,
    standalone: undefined
  };
  const b = browserify(argv);

  return new Promise((resolve, reject) => {
    b.on('error', reject);

    const paths = [];
    b.pipeline.get('deps')
      .push(through.obj((row, enc, next) => {
        const filePath = row.file || row.id;
        // why does browserify add /private + filePath?
        paths.push(stripPath(cwd, filePath));
        next();
      })
      .on('end', () => {
        paths.sort();
        resolve(paths);
      }));
    b.bundle();
  });
};

const listFiles = (dir) => {
  return new Promise((resolve, reject) => {
    const paths = [];
    const cwd = dir + '/';
    fse.walk(dir)
      .on('data', (item) => {
        if (!item.stats.isDirectory()) {
          paths.push(stripPath(cwd, item.path));
        }
      })
      .on('error', reject)
      .on('end', () => {
        paths.sort();
        resolve(paths);
      });
  });
};

const forceIncludeDumbPath = (filePath/*, smartPaths*/) => {
  // we include smartPaths just incase you want to check the inclusion of some library
  return filePath.endsWith('package.json') || filePath.endsWith('definition.json');
};

const makeZip = (dir, zipPath) => {
  return browserifyFiles(dir)
    .then((smartPaths) => Promise.all([
      smartPaths,
      listFiles(dir)
    ]))
    .then(([smartPaths, dumbPaths]) => {
      if (global.argOpts['disable-dependency-detection']) {
        return dumbPaths;
      }
      let finalPaths = smartPaths.concat(dumbPaths.filter(forceIncludeDumbPath, smartPaths));
      finalPaths = _.uniq(finalPaths);
      finalPaths.sort();
      return finalPaths;
    })
    .then((paths) => {
      return new Promise((resolve) => {
        const zip = new AdmZip();
        paths.forEach((filePath) => {
          let basePath = path.dirname(filePath);
          if (basePath === '.') {
            basePath = undefined;
          }
          zip.addLocalFile(path.join(dir, filePath), basePath);
        });
        zip.writeZip(zipPath);
        resolve();
      });
    });
};

// Similar to utils.appCommand, but given a ready to go app
// with a different location and ready to go zapierwrapper.js.
const _appCommandZapierWrapper = (dir, event) => {
  const entry = require(`${dir}/zapierwrapper.js`);
  const promise = makePromise();
  event = Object.assign({}, event, {
    calledFromCli: true,
    doNotMonkeyPatchPromises: true // can drop this
  });
  entry.handler(event, {}, promise.callback);
  return promise;
};

const build = (zipPath, wdir) => {
  wdir = wdir || process.cwd();
  zipPath = zipPath || constants.BUILD_PATH;
  const tmpDir = path.join(os.tmpdir(), 'zapier-' + crypto.randomBytes(4).toString('hex'));
  return ensureDir(tmpDir)
    .then(() => {
      printStarting('Copying project to temp directory');
      return copyDir(wdir, tmpDir);
    })
    .then(() => {
      printDone();
      printStarting('Installing project dependencies');
      return runCommand('npm', ['install', '--production'], {cwd: tmpDir});
    })
    .then(() => {
      printDone();
      printStarting('Applying entry point file');
      // TODO: should this routine for include exist elsewhere?
      return readFile(`${tmpDir}/node_modules/${constants.PLATFORM_PACKAGE}/include/zapierwrapper.js`)
        .then(zapierWrapperBuf => writeFile(`${tmpDir}/zapierwrapper.js`, zapierWrapperBuf.toString()));
    })
    .then(() => {
      printDone();
      printStarting('Validating project');
      return _appCommandZapierWrapper(tmpDir, {command: 'validate'});
    })
    .then((resp) => {
      var errors = resp.results;
      if (errors.length) {
        throw new Error('We hit some validation errors, try running `zapier validate` to see them!');
      } else {
        printDone();
      }
    })
    .then(() => {
      printStarting('Building app definition.json');
      return _appCommandZapierWrapper(tmpDir, {command: 'definition'});
    })
    .then((rawDefinition) => {
      return writeFile(`${tmpDir}/definition.json`, prettyJSONstringify(rawDefinition.results));
    })
    .then(() => {
      // tries to do a reproducible build at least
      // https://blog.pivotal.io/labs/labs/barriers-deterministic-reproducible-zip-files
      // https://reproducible-builds.org/tools/ or strip-nondeterminism
      return runCommand('find', ['.', '-exec', 'touch', '-t', '201601010000', '{}', '+'], {cwd: tmpDir});
    })
    .then(() => {
      printDone();
      printStarting('Zipping project and dependencies');
      return makeZip(tmpDir, wdir + '/' + zipPath);
    })
    .then(() => {
      printDone();
      printStarting('Cleaning up temp directory');
      return removeDir(tmpDir);
    })
    .then(() => {
      printDone();
      return zipPath;
    });
};

const buildAndUploadDir = (zipPath, appDir) => {
  zipPath = zipPath || constants.BUILD_PATH;
  appDir = appDir || '.';
  return checkCredentials()
    .then(() => {
      return build(zipPath, appDir);
    })
    .then(() => {
      return upload(zipPath, appDir);
    });
};

module.exports = {
  build,
  buildAndUploadDir,
};
