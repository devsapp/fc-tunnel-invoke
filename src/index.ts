import logger from './common/logger';
import { InputProps, ICredentials } from './common/entity';
import _ from 'lodash';
import * as core from '@serverless-devs/core';
import StdoutFormatter from './lib/component/stdout-formatter';
import {IProperties} from "./lib/interface/fc-tunnel-invoke";
import {ServiceConfig} from "./lib/interface/fc-service";
import {TriggerConfig} from "./lib/interface/fc-trigger";
import {FunctionConfig} from "./lib/interface/fc-function";
import {CustomDomainConfig} from "./lib/interface/fc-custom-domain";
import path from "path";
import {detectNasBaseDir, updateCodeUriWithBuildPath} from "./lib/devs";
import TunnelService from "./lib/tunnel-service";
import LocalInvoke from "./lib/local-invoke/local-invoke";
import {validateCredentials} from "./lib/validate";
import {getHttpTrigger} from "./lib/definition";
import {getDebugOptions} from "./lib/local-invoke/debug";
import {ensureTmpDir} from "./lib/utils/path";
import {Session} from "./lib/interface/session";


export default class FcTunnelInvokeComponent {

  static readonly supportedDebugIde: string[] = ['vscode', 'intellij'];

  async report(componentName: string, command: string, accountID?: string, access?: string): Promise<void> {
    let uid: string = accountID;
    if (_.isEmpty(accountID)) {
      const credentials: ICredentials = await core.getCredential(access);
      uid = credentials.AccountID;
    }
    try {
      core.reportComponent(componentName, {
        command,
        uid,
      });
    } catch (e) {
      logger.warning(StdoutFormatter.stdoutFormatter.warn('component report', `component name: ${componentName}, method: ${command}`, e.message));
    }
  }

  async handlerInputs(inputs: InputProps): Promise<{[key: string]: any}> {
    await StdoutFormatter.initStdout();
    const project = inputs?.project;
    const access: string = project?.access;
    const creds: ICredentials = await core.getCredential(access);
    validateCredentials(creds);
    await this.report('fc-tunnel-invoke', inputs?.command, creds?.AccountID, inputs?.project?.access);

    const properties: IProperties = inputs?.props;

    const appName: string = inputs?.appName;
    // 去除 args 的行首以及行尾的空格
    const args: string = inputs?.args.replace(/(^\s*)|(\s*$)/g, '');
    const curPath: any = inputs?.path;

    const devsPath: string = curPath?.configPath;
    const nasBaseDir: string = detectNasBaseDir(devsPath);
    const baseDir: string = path.dirname(devsPath);

    const projectName: string = project?.projectName;
    const { region } = properties;
    const parsedArgs: {[key: string]: any} = core.commandParse(inputs, {
      boolean: ['help'],
      alias: { help: 'h' } });
    const argsData: any = parsedArgs?.data || {};
    if (argsData?.help) {
      return {
        region,
        creds,
        path,
        args,
        access,
        isHelp: true,
      };
    }

    const serviceConfig: ServiceConfig = properties?.service;
    const triggerConfigList: TriggerConfig[] = properties?.triggers;
    const customDomainConfigList: CustomDomainConfig[] = properties?.customDomains;
    const functionConfig: FunctionConfig = updateCodeUriWithBuildPath(baseDir, properties?.function, serviceConfig.name);

    return {
      serviceConfig,
      functionConfig,
      triggerConfigList,
      customDomainConfigList,
      region,
      creds,
      curPath,
      args,
      appName,
      projectName,
      devsPath,
      nasBaseDir,
      baseDir,
      access
    };
  }


  /**
   * setup
   * @param inputs
   * @returns
   */
  public async setup(inputs: InputProps) {
    const {
      serviceConfig,
      functionConfig,
      triggerConfigList,
      customDomainConfigList,
      region,
      devsPath,
      nasBaseDir,
      baseDir,
      creds,
      isHelp,
      access,
      appName,
      curPath
    } = await this.handlerInputs(inputs);

    if (isHelp) {
      // TODO: help info
      return;
    }
    // TODO: inputs validation
    const parsedArgs: {[key: string]: any} = core.commandParse(inputs, {
      boolean: ['debug'],
      alias: {
        'help': 'h',
        'debug-port': 'd'
      }
    });
    const argsData: any = parsedArgs?.data || {};
    const {
      debugPort,
      debugIde,
      debuggerPath,
      debugArgs,
    } = getDebugOptions(argsData);
    if (debugIde && !FcTunnelInvokeComponent.supportedDebugIde.includes(_.toLower(debugIde))) {
      logger.error(`Unsupported ide: ${debugIde} for debugging.Only ${FcTunnelInvokeComponent.supportedDebugIde} are supported`);
      return;
    }
    const tunnelService: TunnelService = new TunnelService(creds, serviceConfig, functionConfig, region, access, appName, curPath, triggerConfigList, customDomainConfigList, debugPort, debugIde);
    await tunnelService.setup();
    const session: Session = tunnelService.getSession();
    const httpTrigger: TriggerConfig = getHttpTrigger(triggerConfigList);

    const tmpDir = await ensureTmpDir(argsData['tmp-dir'], devsPath, serviceConfig?.name, functionConfig?.name);
    const localInvoke: LocalInvoke = new LocalInvoke(tunnelService, session?.sessionId, creds, region, baseDir, serviceConfig, functionConfig, httpTrigger, debugPort, debugIde, tmpDir, debuggerPath, debugArgs, nasBaseDir);
    await localInvoke.setup();
  }

  /**
   * invoke
   * @param inputs
   * @returns
   */
  public async invoke(inputs: InputProps) {
    const {
      serviceConfig,
      functionConfig,
      region,
      creds,
      isHelp,
      access,
      appName,
      curPath,
      args
    } = await this.handlerInputs(inputs);
    if (isHelp) {
      // TODO: help info
      return;
    }
    // TODO: inputs validation

    const tunnelService: TunnelService = new TunnelService(creds, serviceConfig, functionConfig, region, access, appName, curPath);
    await tunnelService.invokeHelperFunction(args);
  }

  /**
   * cleanup
   * @param inputs
   * @returns
   */
  public async cleanup(inputs: InputProps) {
    const {
      serviceConfig,
      functionConfig,
      region,
      baseDir,
      creds,
      isHelp,
      access,
      appName,
      curPath
    } = await this.handlerInputs(inputs);
    if (isHelp) {
      // TODO: help info
      return;
    }

    const tunnelService: TunnelService = new TunnelService(creds, serviceConfig, functionConfig, region, access, appName, curPath);
    await tunnelService.clean();

    const localInvoke: LocalInvoke = new LocalInvoke(tunnelService, null, creds, region, baseDir, serviceConfig, functionConfig);
    await localInvoke.clean();
  }

  /**
   * @Decrepted
   * clean
   * @param inputs
   * @returns
   */
  public async clean(inputs: InputProps) {
    logger.warning('Method clean has been decrepted. Please use \'s cleanup\' from now on.');
    await this.cleanup(inputs);
  }

}