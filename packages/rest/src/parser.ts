// Copyright IBM Corp. 2017,2018. All Rights Reserved.
// Node module: @loopback/rest
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {REQUEST_BODY_INDEX} from '@loopback/openapi-v3';
import {
  isReferenceObject,
  OperationObject,
  ParameterObject,
  SchemasObject,
} from '@loopback/openapi-v3-types';
import * as debugModule from 'debug';
import * as HttpErrors from 'http-errors';
import * as parseUrl from 'parseurl';
import {parse as parseQuery} from 'qs';
import {coerceParameter} from './coercion/coerce-parameter';
import {RestHttpErrors} from './index';
import {ResolvedRoute} from './router/routing-table';
import {
  OperationArgs,
  PathParameterValues,
  Request,
  Response,
  RequestBodyParserOptions,
} from './types';
import {validateRequestBody} from './validation/request-body.validator';

import {json, urlencoded, text} from 'body-parser';
import * as typeis from 'type-is';

type HttpError = HttpErrors.HttpError;

const debug = debugModule('loopback:rest:parser');

export const QUERY_NOT_PARSED = {};
Object.freeze(QUERY_NOT_PARSED);

// tslint:disable:no-any
type RequestBody = {
  value: any | undefined;
  coercionRequired?: boolean;
};

/**
 * Parses the request to derive arguments to be passed in for the Application
 * controller method
 *
 * @param request Incoming HTTP request
 * @param route Resolved Route
 */
export async function parseOperationArgs(
  request: Request,
  route: ResolvedRoute,
  options: RequestBodyParserOptions = {},
): Promise<OperationArgs> {
  debug('Parsing operation arguments for route %s', route.describe());
  const operationSpec = route.spec;
  const pathParams = route.pathParams;
  const body = await loadRequestBodyIfNeeded(operationSpec, request, options);
  return buildOperationArguments(
    operationSpec,
    request,
    pathParams,
    body,
    route.schemas,
  );
}

const DEFAULT_LIMIT = '1mb';

function loadRequestBodyIfNeeded(
  operationSpec: OperationObject,
  request: Request,
  options: RequestBodyParserOptions = {},
): Promise<RequestBody> {
  if (!operationSpec.requestBody) return Promise.resolve({value: undefined});

  debug('Request body parser options: %j', options);

  // A hack to fool TypeScript as we don't need `response`
  const response = ({} as any) as Response;

  return new Promise<RequestBody>((resolve, reject) => {
    const handleError = (err: HttpError) => {
      debug('Cannot parse request body %j', err);
      if (!err.statusCode || err.statusCode >= 500) {
        err.statusCode = 400;
      }
      return err;
    };
    let coercionRequired = false;
    const jsonOptions = Object.assign(
      {type: 'json', limit: DEFAULT_LIMIT},
      options,
    );
    json(jsonOptions)(request, response, (err1: HttpError) => {
      if (err1) return reject(handleError(err1));
      const urlencodedOptions = Object.assign(
        {
          extended: true,
          type: 'urlencoded',
          limit: DEFAULT_LIMIT,
        },
        options,
      );
      urlencoded(urlencodedOptions)(request, response, (err2: HttpError) => {
        if (err2) return reject(handleError(err2));
        coercionRequired = true;
        const textOptions = Object.assign(
          {type: 'text', limit: DEFAULT_LIMIT},
          options,
        );
        text(textOptions)(request, response, (err3: HttpError) => {
          if (err3) return reject(handleError(err3));
          if (!typeis(request, 'json', 'urlencoded', 'text')) {
            reject(
              new HttpErrors.UnsupportedMediaType(
                `Content-type ${request.get('content-type')} is not supported.`,
              ),
            );
          } else {
            resolve({value: request.body, coercionRequired});
          }
        });
      });
    });
  });
}

function buildOperationArguments(
  operationSpec: OperationObject,
  request: Request,
  pathParams: PathParameterValues,
  body: RequestBody,
  globalSchemas: SchemasObject,
): OperationArgs {
  let requestBodyIndex: number = -1;
  if (operationSpec.requestBody) {
    // the type of `operationSpec.requestBody` could be `RequestBodyObject`
    // or `ReferenceObject`, resolving a `$ref` value is not supported yet.
    if (isReferenceObject(operationSpec.requestBody)) {
      throw new Error('$ref requestBody is not supported yet.');
    }
    const i = operationSpec.requestBody[REQUEST_BODY_INDEX];
    requestBodyIndex = i ? i : 0;
  }

  const paramArgs: OperationArgs = [];

  for (const paramSpec of operationSpec.parameters || []) {
    if (isReferenceObject(paramSpec)) {
      // TODO(bajtos) implement $ref parameters
      // See https://github.com/strongloop/loopback-next/issues/435
      throw new Error('$ref parameters are not supported yet.');
    }
    const spec = paramSpec as ParameterObject;
    const rawValue = getParamFromRequest(spec, request, pathParams);
    const coercedValue = coerceParameter(rawValue, spec);
    paramArgs.push(coercedValue);
  }

  debug('Validating request body - value %j', body);
  validateRequestBody(body.value, operationSpec.requestBody, globalSchemas, {
    coerceTypes: body.coercionRequired,
  });

  if (requestBodyIndex > -1) paramArgs.splice(requestBodyIndex, 0, body.value);
  return paramArgs;
}

function getParamFromRequest(
  spec: ParameterObject,
  request: Request,
  pathParams: PathParameterValues,
) {
  switch (spec.in) {
    case 'query':
      ensureRequestQueryWasParsed(request);
      return request.query[spec.name];
    case 'path':
      return pathParams[spec.name];
    case 'header':
      // @jannyhou TBD: check edge cases
      return request.headers[spec.name.toLowerCase()];
      break;
    // TODO(jannyhou) to support `cookie`,
    // see issue https://github.com/strongloop/loopback-next/issues/997
    default:
      throw RestHttpErrors.invalidParamLocation(spec.in);
  }
}

function ensureRequestQueryWasParsed(request: Request) {
  if (request.query && request.query !== QUERY_NOT_PARSED) return;

  const input = parseUrl(request)!.query;
  if (input && typeof input === 'string') {
    request.query = parseQuery(input);
  } else {
    request.query = {};
  }
  debug('Parsed request query: ', request.query);
}
