// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as restify from 'restify';
import {makeConfig, SIP002_URI} from 'ShadowsocksConfig/shadowsocks_config';

import {JsonConfig} from '../infrastructure/json_config';
import * as logging from '../infrastructure/logging';
import {AccessKey, AccessKeyQuota, AccessKeyRepository} from '../model/access_key';
import * as errors from '../model/errors';

import {ManagerMetrics} from './manager_metrics';
import {ServerConfigJson} from './server_config';
import {SharedMetricsPublisher} from './shared_metrics';

// Creates a AccessKey response.
function accessKeyToJson(accessKey: AccessKey) {
  return {
    // The unique identifier of this access key.
    id: accessKey.id,
    // Admin-controlled, editable name for this access key.
    name: accessKey.name,
    // Shadowsocks-specific details and credentials.
    password: accessKey.proxyParams.password,
    port: accessKey.proxyParams.portNumber,
    method: accessKey.proxyParams.encryptionMethod,
    accessUrl: SIP002_URI.stringify(makeConfig({
      host: accessKey.proxyParams.hostname,
      port: accessKey.proxyParams.portNumber,
      method: accessKey.proxyParams.encryptionMethod,
      password: accessKey.proxyParams.password,
      outline: 1,
    })),
    quota: accessKey.quotaUsage ? accessKey.quotaUsage.quota : undefined
  };
}

// Simplified request and response type interfaces containing only the
// properties we actually use, to make testing easier.
interface RequestParams {
  id?: string;
  name?: string;
  metricsEnabled?: boolean;
  quota?: AccessKeyQuota;
  port?: number;
}
interface RequestType {
  params: RequestParams;
}
interface ResponseType {
  send(code: number, data?: {}): void;
}

enum HttpSuccess {
  OK = 200,
  NO_CONTENT = 204,
}

export function bindService(
    apiServer: restify.Server, apiPrefix: string, service: ShadowsocksManagerService) {
  apiServer.put(`${apiPrefix}/name`, service.renameServer.bind(service));
  apiServer.get(`${apiPrefix}/server`, service.getServer.bind(service));
  apiServer.put(
      `${apiPrefix}/server/port-for-new-access-keys`,
      service.setPortForNewAccessKeys.bind(service));

  apiServer.post(`${apiPrefix}/access-keys`, service.createNewAccessKey.bind(service));
  apiServer.get(`${apiPrefix}/access-keys`, service.listAccessKeys.bind(service));

  apiServer.del(`${apiPrefix}/access-keys/:id`, service.removeAccessKey.bind(service));
  apiServer.put(`${apiPrefix}/access-keys/:id/name`, service.renameAccessKey.bind(service));
  apiServer.put(`${apiPrefix}/access-keys/:id/quota`, service.setAccessKeyQuota.bind(service));
  apiServer.del(`${apiPrefix}/access-keys/:id/quota`, service.removeAccessKeyQuota.bind(service));

  apiServer.get(`${apiPrefix}/metrics/transfer`, service.getDataUsage.bind(service));
  apiServer.get(`${apiPrefix}/metrics/enabled`, service.getShareMetrics.bind(service));
  apiServer.put(`${apiPrefix}/metrics/enabled`, service.setShareMetrics.bind(service));
}

interface SetShareMetricsParams {
  metricsEnabled: boolean;
}

// The ShadowsocksManagerService manages the access keys that can use the server
// as a proxy using Shadowsocks. It runs an instance of the Shadowsocks server
// for each existing access key, with the port and password assigned for that access key.
export class ShadowsocksManagerService {
  constructor(
      private defaultServerName: string, private serverConfig: JsonConfig<ServerConfigJson>,
      private accessKeys: AccessKeyRepository, private managerMetrics: ManagerMetrics,
      private metricsPublisher: SharedMetricsPublisher) {}

  public renameServer(req: RequestType, res: ResponseType, next: restify.Next): void {
    const name = req.params.name;
    if (typeof name !== 'string' || name.length > 100) {
      next(new restify.InvalidArgumentError(
          `Requested server name should be a string <= 100 characters long.  Got ${name}`));
      return;
    }
    this.serverConfig.data().name = name;
    this.serverConfig.write();
    res.send(HttpSuccess.NO_CONTENT);
    next();
  }

  public getServer(req: RequestType, res: ResponseType, next: restify.Next): void {
    res.send(HttpSuccess.OK, {
      name: this.serverConfig.data().name || this.defaultServerName,
      serverId: this.serverConfig.data().serverId,
      metricsEnabled: this.serverConfig.data().metricsEnabled || false,
      createdTimestampMs: this.serverConfig.data().createdTimestampMs,
      portForNewAccessKeys: this.serverConfig.data().portForNewAccessKeys
    });
    next();
  }

  // Lists all access keys
  public listAccessKeys(req: RequestType, res: ResponseType, next: restify.Next): void {
    logging.debug(`listAccessKeys request ${JSON.stringify(req.params)}`);
    const response = {accessKeys: []};
    for (const accessKey of this.accessKeys.listAccessKeys()) {
      response.accessKeys.push(accessKeyToJson(accessKey));
    }
    logging.debug(`listAccessKeys response ${response}`);
    res.send(HttpSuccess.OK, response);
    return next();
  }

  // Creates a new access key
  public createNewAccessKey(req: RequestType, res: ResponseType, next: restify.Next): void {
    try {
      logging.debug(`createNewAccessKey request ${JSON.stringify(req.params)}`);
      this.accessKeys.createNewAccessKey().then((accessKey) => {
        const accessKeyJson = accessKeyToJson(accessKey);
        res.send(201, accessKeyJson);
        return next();
      });
    } catch (error) {
      logging.error(error);
      return next(new restify.InternalServerError());
    }
  }

  // Sets the default ports for new access keys
  public async setPortForNewAccessKeys(req: RequestType, res: ResponseType, next: restify.Next):
      Promise<void> {
    try {
      logging.debug(`setPort[ForNewAccessKeys request ${JSON.stringify(req.params)}`);
      if (!req.params.port) {
        return next(
            new restify.MissingParameterError({statusCode: 400}, 'Parameter `port` is missing'));
      }

      const port = req.params.port;
      if (typeof port !== 'number') {
        return next(new restify.InvalidArgumentError(
            {statusCode: 400},
            `Expected an numeric port, instead got ${port} of type ${typeof port}`));
      }

      await this.accessKeys.setPortForNewAccessKeys(port);
      this.serverConfig.data().portForNewAccessKeys = port;
      this.serverConfig.write();
      res.send(HttpSuccess.NO_CONTENT);
      next();
    } catch (error) {
      logging.error(error);
      if (error instanceof errors.InvalidPortNumber) {
        return next(new restify.InvalidArgumentError({statusCode: 400}, error.message));
      } else if (error instanceof errors.PortUnavailable) {
        return next(new restify.ConflictError(error.message));
      }
      return next(new restify.InternalServerError(error));
    }
  }

  // Removes an existing access key
  public removeAccessKey(req: RequestType, res: ResponseType, next: restify.Next): void {
    try {
      logging.debug(`removeAccessKey request ${JSON.stringify(req.params)}`);
      const accessKeyId = req.params.id;
      if (!this.accessKeys.removeAccessKey(accessKeyId)) {
        return next(new restify.NotFoundError(`No access key found with id ${accessKeyId}`));
      }
      res.send(HttpSuccess.NO_CONTENT);
      return next();
    } catch (error) {
      logging.error(error);
      return next(new restify.InternalServerError());
    }
  }

  public renameAccessKey(req: RequestType, res: ResponseType, next: restify.Next): void {
    try {
      logging.debug(`renameAccessKey request ${JSON.stringify(req.params)}`);
      const accessKeyId = req.params.id;
      if (!this.accessKeys.renameAccessKey(accessKeyId, req.params.name)) {
        return next(new restify.NotFoundError(`No access key found with id ${accessKeyId}`));
      }
      res.send(HttpSuccess.NO_CONTENT);
      return next();
    } catch (error) {
      logging.error(error);
      return next(new restify.InternalServerError());
    }
  }

  public async setAccessKeyQuota(req: RequestType, res: ResponseType, next: restify.Next) {
    try {
      logging.debug(`setAccessKeyQuota request ${JSON.stringify(req.params)}`);
      const accessKeyId = req.params.id;
      const quota = req.params.quota;
      // TODO(alalama): remove these checks once the repository supports typed errors.
      if (!quota || !quota.data || !quota.window) {
        return next(new restify.InvalidArgumentError(
            'Must provide a quota value with "data.bytes" and "window.hours"'));
      }
      if (quota.data.bytes < 0 || quota.window.hours < 0) {
        return next(new restify.InvalidArgumentError('Must provide positive quota values'));
      }
      const success = await this.accessKeys.setAccessKeyQuota(accessKeyId, quota);
      if (!success) {
        return next(new restify.NotFoundError(`No access key found with id ${accessKeyId}`));
      }
      res.send(HttpSuccess.NO_CONTENT);
      return next();
    } catch (error) {
      logging.error(error);
      return next(new restify.InternalServerError());
    }
  }

  public async removeAccessKeyQuota(req: RequestType, res: ResponseType, next: restify.Next) {
    try {
      logging.debug(`removeAccessKeyQuota request ${JSON.stringify(req.params)}`);
      const accessKeyId = req.params.id;
      const success = await this.accessKeys.removeAccessKeyQuota(accessKeyId);
      if (!success) {
        return next(new restify.NotFoundError(`No access key found with id ${accessKeyId}`));
      }
      res.send(HttpSuccess.NO_CONTENT);
      return next();
    } catch (error) {
      logging.error(error);
      return next(new restify.InternalServerError());
    }
  }

  public async getDataUsage(req: RequestType, res: ResponseType, next: restify.Next) {
    try {
      res.send(HttpSuccess.OK, await this.managerMetrics.get30DayByteTransfer());
      return next();
    } catch (error) {
      logging.error(error);
      return next(new restify.InternalServerError());
    }
  }

  public getShareMetrics(req: RequestType, res: ResponseType, next: restify.Next): void {
    res.send(HttpSuccess.OK, {metricsEnabled: this.metricsPublisher.isSharingEnabled()});
    next();
  }

  public setShareMetrics(req: RequestType, res: ResponseType, next: restify.Next): void {
    if (!req.params) {
      return next(
          new restify.BadRequestError(`No params attached to request.  Instead got ${req}`));
    }
    const enabledType = typeof req.params.metricsEnabled;
    if (enabledType !== 'boolean') {
      return next(
          new restify.BadRequestError(`Expected metricsEnabled to be boolean.  Instead got ${
              req.params.metricsEnabled}, with type ${enabledType}.`));
    }
    const enabled = req.params.metricsEnabled;
    if (enabled) {
      this.metricsPublisher.startSharing();
    } else {
      this.metricsPublisher.stopSharing();
    }
    res.send(HttpSuccess.NO_CONTENT);
    next();
  }
}
