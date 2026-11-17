/**
 * Management API client (fetch based)
 * 替代原项目 src/core/api-client.js
 */

import type { ApiClientConfig, ApiError } from '@/types';
import {
  BUILD_DATE_HEADER_KEYS,
  CPA_BUILD_DATE_HEADER_KEYS,
  CPA_SUPPORT_PLUGIN_HEADER_KEYS,
  CPA_VERSION_HEADER_KEYS,
  REQUEST_TIMEOUT_MS,
  VERSION_HEADER_KEYS,
} from '@/utils/constants';
import { computeApiUrl } from '@/utils/connection';
import { parseApiErrorResponse } from './apiError';
import { HttpError, httpRequest, type HttpRequestConfig, type HttpResponse } from './http';

const ABSOLUTE_URL = /^([a-z][a-z\d+\-.]*:)?\/\//i;

class ApiClient {
  private apiBase: string = '';
  private managementKey: string = '';
  private timeout: number = REQUEST_TIMEOUT_MS;
  private connectionRevision = 0;

  /**
   * 设置 API 配置
   */
  setConfig(config: ApiClientConfig): void {
    const apiBase = computeApiUrl(config.apiBase);
    if (apiBase !== this.apiBase || config.managementKey !== this.managementKey) {
      this.connectionRevision += 1;
    }
    this.apiBase = apiBase;
    this.managementKey = config.managementKey;
    this.timeout = config.timeout || REQUEST_TIMEOUT_MS;
  }

  /** Guards read/modify/write operations across connection changes, including ABA switches. */
  getConnectionRevision(): number {
    return this.connectionRevision;
  }

  private buildUrl(url: string): string {
    if (!this.apiBase || ABSOLUTE_URL.test(url)) return url;
    return `${this.apiBase.replace(/\/?\/$/, '')}/${url.replace(/^\/+/, '')}`;
  }

  private readHeader(headers: Headers, keys: string[]): string | null {
    for (const key of keys) {
      const value = headers.get(key);
      if (value) return value;
    }
    return null;
  }

  private readBooleanHeader(headers: Headers, keys: string[]): boolean | null {
    const value = this.readHeader(headers, keys);
    if (value === null) return null;

    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return null;
  }

  /**
   * Publish backend metadata carried by successful responses.
   */
  private dispatchServerEvents(headers: Headers): void {
    const cpaVersion = this.readHeader(headers, CPA_VERSION_HEADER_KEYS);
    const cpaBuildDate = this.readHeader(headers, CPA_BUILD_DATE_HEADER_KEYS);
    const version = cpaVersion || this.readHeader(headers, VERSION_HEADER_KEYS);
    const buildDate = cpaBuildDate || this.readHeader(headers, BUILD_DATE_HEADER_KEYS);
    const supportsPlugin = this.readBooleanHeader(headers, CPA_SUPPORT_PLUGIN_HEADER_KEYS);

    // 触发版本更新事件（后续通过 store 处理）
    if (version || buildDate) {
      window.dispatchEvent(
        new CustomEvent('server-version-update', {
          detail: { version: version || null, buildDate: buildDate || null },
        })
      );
    }
    if (supportsPlugin !== null) {
      window.dispatchEvent(
        new CustomEvent('server-plugin-support-update', {
          detail: { supportsPlugin },
        })
      );
    }
  }

  /**
   * 错误处理
   */
  private handleError(error: unknown): ApiError {
    if (error instanceof HttpError) {
      const parsedError = parseApiErrorResponse(error.data, error.message);
      const apiError = new Error(parsedError.message) as ApiError;
      apiError.name = 'ApiError';
      apiError.status = error.status;
      apiError.code = error.code;
      apiError.apiCode = parsedError.apiCode;
      apiError.details = error.data;
      apiError.data = error.data;

      // 401 未授权 - 触发登出事件
      if (error.status === 401) {
        window.dispatchEvent(new Event('unauthorized'));
      }

      return apiError;
    }

    const fallbackMessage =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Unknown error occurred';
    const fallback = new Error(fallbackMessage) as ApiError;
    fallback.name = 'ApiError';
    return fallback;
  }

  private async request<T>(
    method: string,
    url: string,
    config: HttpRequestConfig = {}
  ): Promise<HttpResponse<T>> {
    const headers = { ...config.headers };
    if (this.managementKey) {
      headers.Authorization = `Bearer ${this.managementKey}`;
    }

    let response: HttpResponse<T>;
    try {
      response = await httpRequest<T>(method, this.buildUrl(url), {
        ...config,
        headers,
        timeout: config.timeout ?? this.timeout,
      });
    } catch (error) {
      throw this.handleError(error);
    }
    this.dispatchServerEvents(response.headers);
    return response;
  }

  /**
   * GET 请求
   */
  async get<T = unknown>(url: string, config?: HttpRequestConfig): Promise<T> {
    return (await this.request<T>('GET', url, config)).data;
  }

  /**
   * POST 请求
   */
  async post<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<T> {
    return (await this.request<T>('POST', url, { ...config, data })).data;
  }

  /**
   * PUT 请求
   */
  async put<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<T> {
    return (await this.request<T>('PUT', url, { ...config, data })).data;
  }

  /**
   * PATCH 请求
   */
  async patch<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<T> {
    return (await this.request<T>('PATCH', url, { ...config, data })).data;
  }

  /**
   * DELETE 请求
   */
  async delete<T = unknown>(url: string, config?: HttpRequestConfig): Promise<T> {
    return (await this.request<T>('DELETE', url, config)).data;
  }

  /**
   * 获取原始响应（用于下载等场景）
   */
  async getRaw<T = unknown>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>('GET', url, config);
  }

  /**
   * 发送 FormData
   */
  async postForm<T = unknown>(
    url: string,
    formData: FormData,
    config?: HttpRequestConfig
  ): Promise<T> {
    return (await this.request<T>('POST', url, { ...config, data: formData })).data;
  }
}

// 导出单例
export const apiClient = new ApiClient();
