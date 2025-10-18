import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mergeMap, catchError } from 'rxjs/operators';
import { Observable } from 'rxjs';
import { HandlerExecutorService } from '../../infrastructure/handler-executor/services/handler-executor.service';

@Injectable()
export class DynamicInterceptor<T> implements NestInterceptor<T, any> {
  constructor(
    private handlerExecurtorService: HandlerExecutorService,
    private configService: ConfigService,
  ) {}
  async intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Promise<Observable<any>> {
    const req = context.switchToHttp().getRequest();
    const hooks = req.routeData?.hooks;
    if (hooks?.length) {
      for (const hook of hooks) {
        if (!hook.preHook) continue;

        try {
          const code = hook.preHook;
          const preHookTimeout = hook.preHookTimeout || this.configService.get<number>('DEFAULT_PREHOOK_TIMEOUT', 3000);
          const result = await this.handlerExecurtorService.run(
            code,
            req.routeData.context,
            preHookTimeout,
          );

          // Sync modified body back to req.body so controllers can access it
          req.body = req.routeData.context.$body;

          if (result !== undefined) {
            const statusCode = req.routeData.context.$statusCode ?? 200;
            const res = context.switchToHttp().getResponse();
            res
              .status(statusCode)
              .json(
                req.routeData.context.$share.$logs.length
                  ? { result, logs: req.routeData.context.$share.$logs }
                  : result,
              );
            return new Observable();
          }
        } catch (error) {
          throw error;
        }
      }
    }
    return next.handle().pipe(
      mergeMap(async (data) => {
        if (hooks?.length) {
          for (const hook of hooks) {
            if (!hook.afterHook) continue;
            try {
              const code = hook.afterHook;
              const afterHookTimeout = hook.afterHookTimeout || this.configService.get<number>('DEFAULT_AFTERHOOK_TIMEOUT', 3000);
              req.routeData.context.$data = data;
              req.routeData.context.$statusCode = context
                .switchToHttp()
                .getResponse().statusCode;

              // Update API response info
              const responseTime = Date.now() - new Date(req.routeData.context.$api.request.timestamp).getTime();
              req.routeData.context.$api.response = {
                statusCode: req.routeData.context.$statusCode,
                responseTime,
                timestamp: new Date().toISOString(),
              };

              const result = await this.handlerExecurtorService.run(
                code,
                req.routeData.context,
                afterHookTimeout,
              );

              // Check if afterHook returned a value, use it
              if (result !== undefined) {
                data = result;
              } else {
                // Otherwise use the modified $data from context
                data = req.routeData.context.$data;
              }
            } catch (error) {
              throw error;
            }
          }
        }
        
        return req.routeData.context.$share.$logs.length
          ? { ...data, logs: req.routeData.context.$share.$logs }
          : data;
      }),
      catchError(async (error) => {
        // Store error in context for afterHook to handle
        req.routeData.context.$api.error = {
          message: error.message,
          stack: error.stack,
          name: error.constructor.name,
          timestamp: new Date().toISOString(),
          statusCode: error.status || 500,
          details: error.details || {},
        };
        
        // Run afterHook even when there's an error
        if (hooks?.length) {
          for (const hook of hooks) {
            if (!hook.afterHook) continue;
            try {
              const code = hook.afterHook;
              const afterHookTimeout = hook.afterHookTimeout || this.configService.get<number>('DEFAULT_AFTERHOOK_TIMEOUT', 3000);
              req.routeData.context.$data = null; // No data when error occurs
              req.routeData.context.$statusCode = error.status || 500;

              // Update API response info for error case
              const responseTime = Date.now() - new Date(req.routeData.context.$api.request.timestamp).getTime();
              req.routeData.context.$api.response = {
                statusCode: req.routeData.context.$statusCode,
                responseTime,
                timestamp: new Date().toISOString(),
              };

              const result = await this.handlerExecurtorService.run(
                code,
                req.routeData.context,
                afterHookTimeout,
              );

              // Check if afterHook returned a value, use it
              if (result !== undefined) {
                // Return the afterHook result even in error case
                return new Observable(subscriber => {
                  subscriber.next(result);
                  subscriber.complete();
                });
              }
            } catch (afterHookError) {
              // If afterHook itself fails, log it but don't override original error
              console.error('AfterHook failed during error handling:', afterHookError);
            }
          }
        }
        
        // Re-throw the original error
        throw error;
      }),
    );
  }
}
