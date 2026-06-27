// Package tasks implements the data-transfer task types (VOLUME_EXPORT,
// VOLUME_IMPORT, BACKUP, RESTORE) the poller dispatches to. Everything here
// is stdlib-only: docker is driven via os/exec, archives via archive/tar +
// compress/gzip, transfers via net/http.
package tasks

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// Client performs file transfers against the API's agent transfer endpoints:
//
//	POST {apiUrl}/api/agent/transfers/{taskId}/upload?name=...
//	GET  {apiUrl}/api/agent/transfers/{taskId}/download?name=...
//
// The agent token (root-equivalent) and serverId are sent as request HEADERS
// (X-Agent-Token / X-Server-Id), never in the query string — query params
// routinely land in reverse-proxy/access logs, leaking the token. This matches
// how poll/heartbeat/reportResult already authenticate (token in the body).
//
// Upload bodies are raw bytes (application/octet-stream), streamed — no
// buffering of whole archives in memory.
type Client struct {
	apiURL   string
	serverID string
	token    string
	http     *http.Client
}

// NewClient builds a transfer client. The underlying http.Client carries no
// global timeout — multi-GB volume transfers can legitimately take a long
// time; cancellation is governed by the per-operation context instead.
func NewClient(apiURL, serverID, token string) *Client {
	return &Client{
		apiURL:   apiURL,
		serverID: serverID,
		token:    token,
		http:     &http.Client{},
	}
}

func (c *Client) transferURL(kind, taskID, fileName string) string {
	q := url.Values{}
	q.Set("name", fileName)
	return fmt.Sprintf("%s/api/agent/transfers/%s/%s?%s",
		c.apiURL, url.PathEscape(taskID), kind, q.Encode())
}

// authHeaders sets the agent credentials as request headers (off the URL).
func (c *Client) authHeaders(req *http.Request) {
	req.Header.Set("X-Server-Id", c.serverID)
	req.Header.Set("X-Agent-Token", c.token)
}

// Upload streams body to the API as the file fileName under taskID.
// Any 2xx (the contract says 200/201) is success.
func (c *Client) Upload(ctx context.Context, taskID, fileName string, body io.Reader) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.transferURL("upload", taskID, fileName), body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	c.authHeaders(req)

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("upload %s: %w", fileName, err)
	}
	defer resp.Body.Close()
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("upload %s: status %d: %s", fileName, resp.StatusCode, string(msg))
	}
	return nil
}

// Download opens a stream for the file fileName under taskID. The caller
// must Close the returned reader.
func (c *Client) Download(ctx context.Context, taskID, fileName string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.transferURL("download", taskID, fileName), nil)
	if err != nil {
		return nil, err
	}
	c.authHeaders(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", fileName, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return nil, fmt.Errorf("download %s: status %d: %s", fileName, resp.StatusCode, string(msg))
	}
	return resp.Body, nil
}
