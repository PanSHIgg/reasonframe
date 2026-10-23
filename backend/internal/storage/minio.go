package storage

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/reasonframe/reasonframe/backend/internal/config"
)

type Client struct {
	mc     *minio.Client
	bucket string
}

func New(cfg config.S3) (*Client, error) {
	if cfg.Endpoint == "" {
		return nil, fmt.Errorf("S3_ENDPOINT is required")
	}
	endpoint, secure := normalizeEndpoint(cfg.Endpoint, cfg.UseSSL)
	mc, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: secure,
		Region: cfg.Region,
	})
	if err != nil {
		return nil, err
	}
	return &Client{mc: mc, bucket: cfg.Bucket}, nil
}

func (c *Client) PutBytes(ctx context.Context, key string, data []byte, contentType string) error {
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	_, err := c.mc.PutObject(ctx, c.bucket, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: contentType})
	return err
}

func (c *Client) Put(ctx context.Context, key string, reader io.Reader, size int64, contentType string) error {
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	_, err := c.mc.PutObject(ctx, c.bucket, key, reader, size, minio.PutObjectOptions{ContentType: contentType})
	return err
}

func (c *Client) Get(ctx context.Context, key string) (*minio.Object, error) {
	return c.mc.GetObject(ctx, c.bucket, key, minio.GetObjectOptions{})
}

func (c *Client) ReadAll(ctx context.Context, key string, maxBytes int64) ([]byte, error) {
	object, err := c.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	defer object.Close()
	reader := io.Reader(object)
	if maxBytes > 0 {
		reader = io.LimitReader(object, maxBytes+1)
	}
	data, err := io.ReadAll(reader)
	if err != nil {
		return nil, err
	}
	if maxBytes > 0 && int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("object %s exceeds %d bytes", key, maxBytes)
	}
	return data, nil
}

func (c *Client) Stat(ctx context.Context, key string) (minio.ObjectInfo, error) {
	return c.mc.StatObject(ctx, c.bucket, key, minio.StatObjectOptions{})
}

func (c *Client) Remove(ctx context.Context, key string) error {
	return c.mc.RemoveObject(ctx, c.bucket, key, minio.RemoveObjectOptions{})
}

func (c *Client) Ready(ctx context.Context) error {
	exists, err := c.mc.BucketExists(ctx, c.bucket)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("bucket %s does not exist", c.bucket)
	}
	return nil
}

func normalizeEndpoint(raw string, useSSL bool) (string, bool) {
	endpoint := strings.TrimSpace(raw)
	secure := useSSL
	if strings.HasPrefix(endpoint, "https://") {
		secure = true
		endpoint = strings.TrimPrefix(endpoint, "https://")
	} else if strings.HasPrefix(endpoint, "http://") {
		secure = false
		endpoint = strings.TrimPrefix(endpoint, "http://")
	}
	return strings.TrimRight(endpoint, "/"), secure
}
