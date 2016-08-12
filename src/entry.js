require('babel-polyfill');

const _ = require('lodash');
const colors = require('colors/safe');

const {DEBUG, MIN_NODE_VERSION} = require('./constants');
const commands = require('./commands');
const utils = require('./utils');

module.exports = (argv) => {
  process.on('exit', utils.clearSpinner);

  if (!utils.isValidNodeVersion()) {
    console.error(
      `Requires node version >= ${MIN_NODE_VERSION.major}.${MIN_NODE_VERSION.minor}.${MIN_NODE_VERSION.patch}, found ${process.versions.node}. Please upgrade node.`
    );
    /*eslint no-process-exit: 0 */
    process.exit(1);
  }

  if (DEBUG) {
    console.log('running in:', process.cwd());
    console.log('raw argv:', argv);
    console.log('\n--------------------------------------------------\n\n');
  }

  argv = argv.slice(2); // strip path, zapier.js

  let [args, argOpts] = utils.argParse(argv);
  global.argOpts = argOpts;

  // when `zapier invitees --help`, swap to `zapier help invitees`
  if (argOpts.help || args.length === 0) {
    args = ['help'].concat(args);
  }

  const command = args[0];
  args = args.slice(1);

  // create the context, logs thread through this
  const context = utils.createContext({command, args});

  let commandFunc = commands[command];
  if (!commandFunc) {
    commandFunc = commands.help;
    context.line(`${command} not a command! Try running \`zapier help\`?`);
    return;
  }

  // TODO: maybe rip off heroku formatting?
  // ➜  testing heroku version --lolzwhat
  // !    Invalid argument: "--lolzwhat"
  // <PRINTS heroku version --help>
  const spec = {
    argsSpec: commandFunc.argsSpec,
    argOptsSpec: _.extend({}, utils.globalArgOptsSpec, commandFunc.argOptsSpec)
  };
  const errors = utils.enforceArgSpec(spec, args, argOpts);
  if (errors.length) {
    errors.forEach((error) => {
      context.line(' ' + colors.red(error));
    });
    context.line(colors.grey('\nAdjust your command and try again!'));
    // TODO: print commands help?
    return;
  }

  commandFunc.apply(commands, [context].concat(args))
    .then(() => {
      utils.clearSpinner();
      context.line('');
    })
    .catch((err) => {
      utils.clearSpinner();
      if (DEBUG || global.argOpts.debug) {
        context.line('');
        context.line(err.stack);
        context.line('');
        context.line(colors.red('Error!'));
      } else {
        context.line('');
        context.line('');
        context.line(colors.red('Error!') + ' ' + colors.red(err.message));
        context.line(colors.grey('(Use --debug flag and run this command again to get more details.)'));
      }
      throw err;
    });
};
