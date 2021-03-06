import { Subject, of, fromEvent, Observable } from 'rxjs';
import { takeUntil, share, take, mergeMap, map, catchError } from 'rxjs/operators';
import { pipe } from 'fp-ts/lib/pipeable';
import { EffectContext } from '../../effects/effects.interface';
import { HttpServer, HttpRequest } from '../http.interface';
import { defaultError$ } from '../error/http.error.effect';
import { HttpEffectResponse, HttpErrorEffect, HttpOutputEffect } from '../effects/http.effects.interface';
import {
  unexpectedErrorWhileSendingErrorFactory,
  unexpectedErrorWhileSendingOutputFactory,
  errorNotBoundToRequestErrorFactory,
  responseNotBoundToRequestErrorFactory,
  isHttpRequestError,
} from '../error/http.error.model';
import { useContext } from '../../context/context.hook';
import { LoggerToken, LoggerTag, LoggerLevel } from '../../logger';
import { HttpRequestBusToken } from '../server/internal-dependencies/httpRequestBus.reader';
import { Routing, BootstrappedRoutingItem } from './http.router.interface';
import { queryParamsFactory } from './http.router.query.factory';
import { matchRoute } from './http.router.matcher';
import { ROUTE_NOT_FOUND_ERROR } from './http.router.effects';
import { decorateEffect } from './http.router.helpers';
import { combineRouteMiddlewares } from './http.router.combiner';

export const resolveRouting = (
  routing: Routing,
  ctx: EffectContext<HttpServer>,
) => (
  output$?: HttpOutputEffect,
  error$?: HttpErrorEffect,
) => {
  const requestBus = useContext(HttpRequestBusToken)(ctx.ask);
  const logger = useContext(LoggerToken)(ctx.ask);

  const close$ = fromEvent(ctx.client, 'close').pipe(take(1), share());
  const outputSubject = new Subject<{ res: HttpEffectResponse; req: HttpRequest}>();
  const errorSubject = new Subject<{ error: Error; req: HttpRequest }>();

  const outputFlow$ = outputSubject.asObservable().pipe(
    mergeMap(data => {
      const stream = output$ ? output$(of(data), ctx) : of(data.res);
      return stream.pipe(
        map(res => ([res, data.req] as [HttpEffectResponse, HttpRequest])),
      );
    }),
    takeUntil(close$),
  );

  const errorFlow$ = errorSubject.asObservable().pipe(
    map(data => isHttpRequestError(data.error) ? { ...data, error: data.error.error } : data),
    mergeMap(data => {
      const stream = error$ ? error$(of(data), ctx) : defaultError$(of(data), ctx);
      return stream.pipe(
        map(res => ([res, data.req] as [HttpEffectResponse, HttpRequest])),
      );
    }),
    takeUntil(close$),
  );

  const subscribeOutput = (stream$: Observable<[HttpEffectResponse, HttpRequest]>) =>
    stream$.subscribe(
      ([res, req]) => req.response.send(res),
      error => { throw unexpectedErrorWhileSendingOutputFactory(error) },
    );

  const subscribeError = (stream$: Observable<[HttpEffectResponse, HttpRequest]>) =>
    stream$.subscribe(
      ([res, req]) => req.response.send(res),
      error => { throw unexpectedErrorWhileSendingErrorFactory(error) },
    );

  subscribeOutput(outputFlow$);
  subscribeError(errorFlow$);

  const bootstrappedRrouting: BootstrappedRoutingItem[] = routing.map(item => ({
    ...item,
    methods: Object.entries(item.methods).reduce((acc, [method, methodItem]) => {
      if (!methodItem) return { [method]: undefined };

      const { middlewares, effect, parameters, meta } = methodItem;
      const subject = new Subject<HttpRequest>();
      const decorate = !meta?.continuous;
      const middleware = combineRouteMiddlewares(decorate, errorSubject)(...middlewares);

      logger({
        tag: LoggerTag.HTTP,
        type: 'Router',
        message: `Effect mapped: ${item.path || '/'} ${method}`,
      })();

      const output$ = pipe(
        subject.asObservable(),
        e$ => middleware(e$, ctx),
        e$ => decorate ? decorateEffect(e$, errorSubject) : e$,
        e$ => effect(e$, ctx),
        catchError((error, stream) => processError(stream)(error)),
        takeUntil(close$),
      );

      const processError = (originStream$: Observable<any>) => (error: any) => {
        if (!error.request) throw errorNotBoundToRequestErrorFactory(error);
        errorSubject.next({ error, req: error.request });
        return originStream$;
      };

      const subscribe = (stream$: Observable<HttpEffectResponse>) =>
        stream$.subscribe(
          res => {
            if (!res.request) throw responseNotBoundToRequestErrorFactory(res);
            outputSubject.next({ res, req: res.request });
          },
          error => {
            const type = 'RouterResolver';
            const message = `Unexpected error for Output stream: "${error.name}", "${error.message}"`;
            logger({ tag: LoggerTag.HTTP, type, message, level: LoggerLevel.ERROR })();
          },
          () => {
            const type = 'RouterResolver';
            const message = `Effect stream completes`;
            logger({ tag: LoggerTag.HTTP, type, message, level: LoggerLevel.DEBUG })();
          }
        );

      subscribe(output$);

      return {
        ...acc,
        [method]: { subject, parameters },
      };
    }, {}),
  }));

  const find = matchRoute(bootstrappedRrouting);

  const resolve = (req: HttpRequest) => {
    const [urlPath, urlQuery] = req.url.split('?');
    const resolvedRoute = find(urlPath, req.method);

    if (!resolvedRoute) {
      return errorSubject.next({ req, error: ROUTE_NOT_FOUND_ERROR });
    }

    req.query = queryParamsFactory(urlQuery);
    req.params = resolvedRoute.params;
    req.meta = {};
    req.meta.path = resolvedRoute.path;

    resolvedRoute.subject.next(req);
    requestBus.next(req);
  };

  return {
    resolve,
    errorSubject,
    outputSubject,
  }
};
