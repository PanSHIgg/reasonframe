package ai

import (
	"context"
	"fmt"
	"sync"
	"time"

	"strings"

	"github.com/reasonframe/reasonframe/backend/internal/ai/pipelinev1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

type Manager struct {
	mu      sync.Mutex
	conns   map[string]*grpc.ClientConn
	clients map[string]pipelinev1.PipelineServiceClient
	token   string
}

func NewManager(addresses []string, internalToken string) (*Manager, error) {
	m := &Manager{
		conns:   map[string]*grpc.ClientConn{},
		clients: map[string]pipelinev1.PipelineServiceClient{},
		token:   internalToken,
	}
	for _, addr := range addresses {
		if addr == "" {
			continue
		}
		conn, err := grpc.NewClient(grpcTarget(addr), grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			m.Close()
			return nil, fmt.Errorf("connect AI %s: %w", addr, err)
		}
		m.conns[addr] = conn
		m.clients[addr] = pipelinev1.NewPipelineServiceClient(conn)
	}
	return m, nil
}

func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, conn := range m.conns {
		_ = conn.Close()
	}
	m.conns = map[string]*grpc.ClientConn{}
	m.clients = map[string]pipelinev1.PipelineServiceClient{}
}

func (m *Manager) Client(addr string) (pipelinev1.PipelineServiceClient, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	client, ok := m.clients[addr]
	return client, ok
}

func (m *Manager) Context(ctx context.Context) context.Context {
	if m.token == "" {
		return ctx
	}
	return metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+m.token)
}

func (m *Manager) Health(ctx context.Context, addr string) (*pipelinev1.HealthResponse, error) {
	client, ok := m.Client(addr)
	if !ok {
		return nil, fmt.Errorf("AI address %q is not configured", addr)
	}
	callCtx, cancel := context.WithTimeout(m.Context(ctx), 2*time.Second)
	defer cancel()
	return client.Health(callCtx, &pipelinev1.HealthRequest{})
}

func (m *Manager) RunTask(ctx context.Context, addr string, req *pipelinev1.RunTaskRequest) (pipelinev1.PipelineService_RunTaskClient, error) {
	client, ok := m.Client(addr)
	if !ok {
		return nil, fmt.Errorf("AI address %q is not configured", addr)
	}
	return client.RunTask(m.Context(ctx), req)
}

func (m *Manager) Cancel(ctx context.Context, addr, taskID, jobID, reason string) error {
	client, ok := m.Client(addr)
	if !ok {
		return fmt.Errorf("AI address %q is not configured", addr)
	}
	callCtx, cancel := context.WithTimeout(m.Context(ctx), 3*time.Second)
	defer cancel()
	_, err := client.Cancel(callCtx, &pipelinev1.CancelRequest{TaskId: taskID, JobId: jobID, Reason: reason})
	return err
}

func grpcTarget(addr string) string {
	if strings.Contains(addr, "://") {
		return addr
	}
	return "dns:///" + addr
}
